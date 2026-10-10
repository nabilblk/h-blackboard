"""Separate provider/public CONNECT proxies. No TLS interception or credentials.

The public socket is only mounted into an explicitly internet-enabled worker
namespace. It resolves every tunnel destination itself and connects to the
validated numeric address; clients never obtain a general network interface.
"""
import asyncio
import ipaddress
import os
import re
import socket
import sys
import time

HOSTS = frozenset()  # Deny everything until the root-owned runtime policy loads.
IDLE_SECONDS = 900
IDLE_POLL = 30
PUBLIC = False
MAX_CONNECTIONS = 64
connections = 0
PUBLIC_SOCKET = "/run/harakiri-internet/proxy.sock"


def parse_destination(value):
    """Strict authority parsing; no URL credentials, ambiguous IPs or scopes."""
    if value.startswith("["):
        match = re.fullmatch(r"\[([0-9a-fA-F:]+)\]:443", value)
        if not match:
            raise ValueError("destination")
        return str(ipaddress.IPv6Address(match[1]))
    match = re.fullmatch(r"([A-Za-z0-9.-]{1,253}):443", value)
    if not match:
        raise ValueError("destination")
    host = match[1].lower()
    if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
               for label in host.split(".")):
        raise ValueError("hostname")
    return host


def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global or address.is_multicast or address.is_reserved:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # Avoid translation/tunnel prefixes and IPv4-mapped surprises on older
        # guest Python releases. Public native unicast only.
        return (address in ipaddress.ip_network("2000::/3") and
                address not in ipaddress.ip_network("2001::/23") and
                address not in ipaddress.ip_network("2002::/16"))
    return address not in ipaddress.ip_network("192.0.0.0/24")


async def proxy(reader, writer):
    global connections
    if connections >= MAX_CONNECTIONS:
        writer.write(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
        writer.close()
        return
    connections += 1
    upstream = None
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        if len(header) > 8192:
            raise ValueError("header")
        method, destination, protocol = header.split(b"\r\n", 1)[0].decode("ascii").split(" ")
        # Python urllib emits HTTP/1.0 CONNECT on the pinned Ubuntu release.
        if method != "CONNECT" or protocol not in ("HTTP/1.0", "HTTP/1.1"):
            raise ValueError("destination")
        host = parse_destination(destination)
        if not PUBLIC and host not in HOSTS:
            raise ValueError("destination")
        if PUBLIC and ("." not in host and ":" not in host or
                       host.endswith((".localhost", ".local", ".internal", ".test", ".invalid"))):
            raise ValueError("local hostname")
        addresses = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(
            host, 443, type=socket.SOCK_STREAM), 10)
        if not addresses or any(not public_address(a[4][0]) for a in addresses):
            raise ValueError("non-public address")
        # Connect to the vetted numeric address: a second DNS lookup cannot
        # rebind the destination to a LAN, host, link-local or metadata service.
        incoming, upstream = await asyncio.wait_for(asyncio.open_connection(addresses[0][4][0], 443), 15)
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
        activity = time.monotonic()

        async def copy(source, target):
            nonlocal activity
            while data := await source.read(65536):
                activity = time.monotonic()
                target.write(data)
                await target.drain()

        async def idle():
            # A streaming inference request sends no more client bytes after
            # its body. Activity in either direction keeps the tunnel alive;
            # the execution service separately enforces the signed deadline.
            while time.monotonic() - activity < IDLE_SECONDS:
                await asyncio.sleep(IDLE_POLL)

        tasks = [asyncio.create_task(copy(reader, upstream)), asyncio.create_task(copy(incoming, writer)),
                 asyncio.create_task(idle())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except (ValueError, OSError, UnicodeError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        if upstream is None:
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
    finally:
        connections -= 1
        if upstream:
            upstream.close()
        writer.close()


async def main():
    global HOSTS, PUBLIC
    from runtimes import spec
    if sys.argv[1:] == ["--workspace"]:
        if spec().get("networkAccess", "restricted") != "internet":
            raise ValueError("Workspace internet access is not approved")
        PUBLIC = True
        if os.path.exists(PUBLIC_SOCKET):
            os.unlink(PUBLIC_SOCKET)
        server = await asyncio.start_unix_server(proxy, PUBLIC_SOCKET, limit=8192)
        os.chmod(PUBLIC_SOCKET, 0o660)
    elif not sys.argv[1:]:
        HOSTS = frozenset(spec()["hosts"])
        server = await asyncio.start_server(proxy, "127.0.0.1", 18080, limit=8192)
    else:
        raise ValueError("Unsupported proxy mode")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
