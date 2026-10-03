"""Provider-only CONNECT proxy. No TLS interception or credential handling."""
import asyncio
import ipaddress
import socket
import time

HOSTS = frozenset()  # Deny everything until the root-owned runtime policy loads.
IDLE_SECONDS = 900
IDLE_POLL = 30


async def proxy(reader, writer):
    upstream = None
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        if len(header) > 8192:
            raise ValueError("header")
        method, destination, protocol = header.split(b"\r\n", 1)[0].decode("ascii").split(" ")
        host, port = destination.split(":")
        if method != "CONNECT" or protocol != "HTTP/1.1" or host not in HOSTS or port != "443":
            raise ValueError("destination")
        addresses = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
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
    except (ValueError, OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        if upstream is None:
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
    finally:
        if upstream:
            upstream.close()
        writer.close()


async def main():
    global HOSTS
    from runtimes import spec
    HOSTS = frozenset(spec()["hosts"])
    server = await asyncio.start_server(proxy, "127.0.0.1", 18080, limit=8192)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
