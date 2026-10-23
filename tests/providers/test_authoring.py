import hashlib
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/"desktop/execution/guest"))
import files
from command import execute
import command


class AuthoringTests(unittest.TestCase):
    def test_search_is_bounded_and_locates_late_matches_without_hiding_omissions(self):
        data = ("blank\n" * 2000 + "needle🌍\n" * 51).encode()
        with patch.object(files,"read",return_value=data):
            result = files.main({"action":"search","paths":["src/lesson.js"],"query":"needle🌍"})
            self.assertEqual(result["matching_lines"],51)
            self.assertEqual(len(result["matches"]),40)
            self.assertEqual(result["matches"][0]["line"],2001)
            self.assertTrue(result["truncated"])
            self.assertEqual(result["matches"][0]["sha256"],hashlib.sha256(data).hexdigest())
            self.assertEqual(files.main({"action":"search","paths":["src/lesson.js"],"query":"absent"})["matches"],[])

    def test_utf8_ranges_and_stale_patch_never_write(self):
        data="a🌍bc".encode()
        digest=hashlib.sha256(data).hexdigest()
        with patch.object(files,"read",return_value=data),patch.object(files,"write") as write:
            value=files.main({"action":"read_text","path":"a","offset":1,"limit":1})
            self.assertEqual(value["text"],"🌍")
            self.assertEqual(value["next_offset"],2)
            self.assertEqual(value["sha256"],digest)
            for request in ({"action":"read_text","path":"a","sha256":"old"},
                            {"action":"patch","path":"a","sha256":"old","edits":[{"old":"b","new":"c"}]},
                            {"action":"patch","path":"a","sha256":digest,"edits":[{"old":"missing","new":"c"}]}):
                with self.assertRaises(ValueError): files.main(request)
            write.assert_not_called()
            files.main({"action":"patch","path":"a","sha256":digest,"edits":[{"old":"bc","new":"42"}]})
            write.assert_called_once_with("a","a🌍42".encode())

    def test_timeout_and_large_output_are_explicit_and_retrievable(self):
        saved={}
        result=execute({"command":"python3 -c 'print(\"x\"*40000)'","timeout_seconds":5},lambda p,d:saved.update({p:d}))
        self.assertEqual(result["exitCode"],0)
        log=result["logs"]["stdout"]
        self.assertTrue(log["preview_truncated"])
        self.assertFalse(log["capture_truncated"])
        self.assertEqual(len(saved[log["path"]]),40001)
        self.assertEqual(hashlib.sha256(saved[log["path"]]).hexdigest(),log["sha256"])
        receipt = json.loads(saved[result["receipt"]])
        self.assertEqual(receipt["logs"],result["logs"])
        self.assertEqual(receipt["exitCode"],0)
        result=execute({"command":"sleep 10","timeout_seconds":1},lambda p,d:None)
        self.assertTrue(result["timed_out"])
        self.assertNotEqual(result["exitCode"],0)

    def test_binary_replacement_stays_within_the_saved_output_bound(self):
        saved = {}
        with patch.object(command,"CAPTURE",64):
            result=execute({"command":"python3 -c 'import sys;sys.stdout.buffer.write(bytes([255])*60)'"},lambda p,d:saved.update({p:d}))
        log=result["logs"]["stdout"]
        self.assertTrue(log["encoding_truncated"])
        self.assertTrue(log["capture_truncated"])
        self.assertLessEqual(len(saved[log["path"]]),64)
        self.assertEqual(log["output_bytes"],60)
        saved[log["path"]].decode("utf8")
