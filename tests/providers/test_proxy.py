"""Fast policy/duplex regression tests. No provider account or external traffic."""
import asyncio
import importlib.util
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hb_proxy", Path(__file__).parents[2] / "desktop/execution/guest/proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = await asyncio.start_server(proxy.proxy, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.original_connect = asyncio.open_connection

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def request(self, destination):
        reader, writer = await self.original_connect("127.0.0.1", self.port)
        writer.write(f"CONNECT {destination} HTTP/1.1\r\n\r\n".encode())
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), 3)
        writer.close()
        await writer.wait_closed()
        return response

    async def test_disallowed_destinations_never_resolve(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", side_effect=AssertionError("unexpected DNS")):
            for target in ["example.com:443", "127.0.0.1:443", "169.254.169.254:443", "auth.x.ai:80", "auth.x.ai.evil.test:443"]:
                self.assertIn(b"403 Forbidden", await self.request(target))

    async def test_allowlisted_dns_cannot_rebind_into_private_network(self):
        loop = asyncio.get_running_loop()
        for address in ["127.0.0.1", "192.168.5.2", "169.254.169.254", "::1", "fc00::1"]:
            with patch.object(loop, "getaddrinfo", return_value=[(2, 1, 6, "", (address, 443))]):
                self.assertIn(b"403 Forbidden", await self.request("auth.x.ai:443"))

    async def test_server_stream_survives_client_silence_and_uses_vetted_numeric_ip(self):
        async def upstream(_reader, writer):
            for _ in range(6):
                await asyncio.sleep(0.06)
                writer.write(b"stream\n")
                await writer.drain()
            writer.close()

        server = await asyncio.start_server(upstream, "127.0.0.1", 0)
        seen = []

        async def connect(host, port):
            seen.append((host, port))
            return await self.original_connect("127.0.0.1", server.sockets[0].getsockname()[1])

        loop = asyncio.get_running_loop()
        try:
            with patch.object(loop, "getaddrinfo", return_value=[(socket.AF_INET, 1, 6, "", ("8.8.8.8", 443))]), patch.object(asyncio, "open_connection", connect), patch.object(proxy, "IDLE_SECONDS", 0.12), patch.object(proxy, "IDLE_POLL", 0.01):
                response = await self.request("cli-chat-proxy.grok.com:443")
            self.assertEqual(seen, [("8.8.8.8", 443)])
            self.assertIn(b"200 Connection Established", response)
            self.assertEqual(response.count(b"stream\n"), 6)
        finally:
            server.close()
            await server.wait_closed()


if __name__ == "__main__":
    unittest.main()
