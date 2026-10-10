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
        self.previous_hosts = proxy.HOSTS
        self.previous_public = proxy.PUBLIC
        proxy.HOSTS = frozenset({"cli-chat-proxy.grok.com", "auth.x.ai"})
        self.server = await asyncio.start_server(proxy.proxy, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.original_connect = asyncio.open_connection

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        proxy.HOSTS = self.previous_hosts
        proxy.PUBLIC = self.previous_public

    async def request(self, destination, protocol="HTTP/1.1"):
        reader, writer = await self.original_connect("127.0.0.1", self.port)
        writer.write(f"CONNECT {destination} {protocol}\r\n\r\n".encode())
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

    async def test_unconfigured_or_other_runtime_hosts_are_denied(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", side_effect=AssertionError("unexpected DNS")):
            for host in ["api.anthropic.com", "api.openai.com"]:
                self.assertIn(b"403 Forbidden", await self.request(host + ":443"))
            with patch.object(proxy, "HOSTS", frozenset()):
                self.assertIn(b"403 Forbidden", await self.request("auth.x.ai:443"))

    async def test_allowlisted_dns_cannot_rebind_into_private_network(self):
        loop = asyncio.get_running_loop()
        for address in ["127.0.0.1", "192.168.5.2", "169.254.169.254", "::1", "fc00::1"]:
            with patch.object(loop, "getaddrinfo", return_value=[(2, 1, 6, "", (address, 443))]):
                self.assertIn(b"403 Forbidden", await self.request("auth.x.ai:443"))

    async def test_server_stream_survives_client_silence_and_uses_vetted_numeric_ip(self):
        await self.stream("cli-chat-proxy.grok.com:443")

    async def test_opt_in_public_proxy_supports_urllib_and_pins_public_dns(self):
        proxy.PUBLIC = True
        await self.stream("registry.npmjs.org:443", "HTTP/1.0")

    async def test_public_proxy_denies_ambiguous_authorities_and_non_https_before_dns(self):
        proxy.PUBLIC = True
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", side_effect=AssertionError("unexpected DNS")):
            for target in ["localhost:443", "machine.local:443", "metadata.google.internal:443",
                           "2130706433:443", "0x7f000001:443", "user@example.com:443",
                           "example.com:80", "example.com:22", "example.com:0443", "example.com:443/path",
                           "example.com:443?query", "[fe80::1%25eth0]:443", "example.com.:443", "example..com:443"]:
                self.assertIn(b"403 Forbidden", await self.request(target), target)

    async def test_public_proxy_denies_private_reserved_translation_and_mixed_dns_answers(self):
        proxy.PUBLIC = True
        loop = asyncio.get_running_loop()
        for ip in ["127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.0.1", "192.168.1.1",
                   "169.254.169.254", "100.100.100.200", "192.0.0.8", "224.0.0.1", "255.255.255.255",
                   "::1", "::", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1",
                   "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "2001:db8::1"]:
            for answers in [[ip], ["8.8.8.8", ip]]:
                with patch.object(loop, "getaddrinfo", return_value=[(2, 1, 6, "", (a, 443)) for a in answers]), \
                     patch.object(asyncio, "open_connection", side_effect=AssertionError("unexpected connection")):
                    self.assertIn(b"403 Forbidden", await self.request("public.example:443"), answers)

    async def test_missing_or_invalid_public_dns_fails_closed(self):
        proxy.PUBLIC = True
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", return_value=[]):
            self.assertIn(b"403 Forbidden", await self.request("example.com:443"))
        with patch.object(loop, "getaddrinfo", side_effect=socket.gaierror("unavailable")):
            self.assertIn(b"403 Forbidden", await self.request("example.com:443"))

    async def stream(self, destination, protocol="HTTP/1.1"):
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
                response = await self.request(destination, protocol)
            self.assertEqual(seen, [("8.8.8.8", 443)])
            self.assertIn(b"200 Connection Established", response)
            self.assertEqual(response.count(b"stream\n"), 6)
        finally:
            server.close()
            await server.wait_closed()


if __name__ == "__main__":
    unittest.main()
