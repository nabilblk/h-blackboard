"""A local proxy adapter inside one jailed, network-isolated worker command.

No external socket is opened here. A filesystem Unix socket reaches the
separate public-destination validator; its policy is root-owned and absent
from this jail. Removing proxy variables does not create a direct route.
"""
import asyncio
import os
import sys

SOCKET = "/run/harakiri-internet/proxy.sock"
LIMIT = 64
active = 0


async def relay(reader, writer):
    global active
    if active >= LIMIT:
        writer.close()
        return
    active += 1
    remote = None
    tasks = []
    try:
        incoming, remote = await asyncio.wait_for(asyncio.open_unix_connection(SOCKET), 5)

        async def copy(source, target):
            while data := await source.read(65536):
                target.write(data)
                await target.drain()

        tasks = [asyncio.create_task(copy(reader, remote)),
                 asyncio.create_task(copy(incoming, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, asyncio.TimeoutError):
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
    finally:
        active -= 1
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if remote:
            remote.close()
        writer.close()


async def main():
    if len(sys.argv) < 2:
        raise ValueError("Missing worker command")
    server = await asyncio.start_server(relay, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    env = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env[key] = f"http://127.0.0.1:{port}"
    env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1,::1"
    env["SSL_CERT_FILE"] = "/etc/ssl/certs/ca-certificates.crt"
    async with server:
        child = await asyncio.create_subprocess_exec(*sys.argv[1:], env=env)
        return await child.wait()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
