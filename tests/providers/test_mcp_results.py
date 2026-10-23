"""Real MCP formatting must keep every byte accessible within the sandbox."""
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
import mcp
from mcp_results import ResultCache, MAX_BYTES, MAX_ENTRIES


class ResultPagingTests(unittest.TestCase):
    def test_delivery_requires_complete_contiguous_content_not_the_last_chunk(self):
        receipts = []
        cache = ResultCache(delivered=lambda token, paths: receipts.append((token, paths)))
        context = {"updates": {"items": [{"id": "a"*64, "text": "x"*22000}]}, "_delivery": {"token": "ticket"}}
        meta = cache.present(context)
        self.assertNotIn("_delivery", meta)
        self.assertEqual(receipts, [])
        # Reading only the final part must not claim the preceding bytes.
        cache.read({"result_id":meta["result_id"],"pointer":"/updates/items/0","offset":22000})
        self.assertEqual(receipts, [])
        offset = 0
        while offset is not None:
            part = cache.read({"result_id":meta["result_id"],"pointer":"/updates/items/0","offset":offset})
            offset = part["next_offset"]
        self.assertEqual(receipts[-1], ("ticket", ["/updates/items/0"]))

    def test_large_scoped_context_is_complete_and_each_reply_fits_harness(self):
        cache = ResultCache()
        context = {"context": {"scope": ('Quoted "text" \\ 🌍\n' * 3000)},
                   "main": {"items": [{"id": "a" * 64, "text": "A direction"}]}}
        with patch.object(mcp, "RESULTS", cache), patch.object(mcp, "call", return_value={"allowed": True}) as permission:
            envelope = mcp.tool_result("board", context)
            meta = json.loads(envelope["content"][0]["text"])
            self.assertTrue(meta["paged_result"])
            offset, chunks = 0, []
            while True:
                value = mcp.read_tool_result({"result_id": meta["result_id"], "pointer": "/context/scope", "offset": offset})
                response = mcp.tool_result("read_tool_result", value)
                self.assertLess(len(response["content"][0]["text"].encode()), 19500)
                chunks.append(value["text"])
                offset = value["next_offset"]
                if offset is None:
                    break
            self.assertEqual(json.loads(''.join(chunks)), context["context"]["scope"])
            self.assertEqual(permission.call_count, len(chunks))
            permission.assert_called_with("check_permission", {})

    def test_cache_is_bounded_expires_and_never_reads_paths(self):
        now = [0]
        cache = ResultCache(clock=lambda: now[0])
        first = cache.present({"text": "x" * 900000})["result_id"]
        for _ in range(12):
            cache.present({"text": "x" * 900000})
        self.assertLessEqual(len(cache.entries), MAX_ENTRIES)
        self.assertLessEqual(sum(len(v[1]) for v in cache.entries.values()), MAX_BYTES)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            cache.read({"result_id": first})
        newest = next(reversed(cache.entries))
        with self.assertRaisesRegex(ValueError, "unavailable"):
            ResultCache().read({"result_id": newest})
        for request in ({"result_id": "/etc/passwd"}, {"result_id": newest, "path": "/etc/passwd"},
                        {"result_id": newest, "pointer": "/text", "offset": -1},
                        {"result_id": newest, "offset": True},
                        {"result_id": newest, "pointer": "/text~2"}):
            with self.assertRaises(ValueError):
                cache.read(request)
        now[0] = 601
        with self.assertRaisesRegex(ValueError, "expired"):
            cache.read({"result_id": newest})

    def test_json_pointer_is_data_and_revocation_blocks_saved_replies(self):
        cache = ResultCache()
        data = {"padding": "x" * 14000, "a/b": {"~": ["exact"]}}
        meta = cache.present(data)
        self.assertEqual(json.loads(cache.read({"result_id": meta["result_id"], "pointer": "/a~1b/~0/0"})["text"]), "exact")
        array = cache.read({"result_id": meta["result_id"], "pointer": "/a~1b/~0"})
        self.assertEqual(array["item_count"], 1)
        with self.assertRaisesRegex(ValueError, "array has 1 items"):
            cache.read({"result_id": meta["result_id"], "pointer": "/a~1b/~0/9"})
        with self.assertRaisesRegex(ValueError, "returned next_offset"):
            cache.read({"result_id": meta["result_id"], "pointer": "/a~1b/~0", "offset": 100})
        with patch.object(mcp, "RESULTS", cache), patch.object(mcp, "call", return_value={"allowed": False}):
            with self.assertRaisesRegex(ValueError, "permission"):
                mcp.read_tool_result({"result_id": meta["result_id"]})
        self.assertEqual(cache.present({"context": "small"}), {"context": "small"})
