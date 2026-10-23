import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
from project import manifest
import command


class ProjectTests(unittest.TestCase):
    def test_manifest_excludes_secrets_dependencies_and_links_and_records_omissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "src").mkdir()
            (root / "src/a.js").write_text("hello")
            (root / ".env").write_text("never export")
            (root / "node_modules").mkdir()
            (root / "node_modules/huge").write_text("cache")
            (root / "escape").symlink_to("/etc/passwd")
            value = manifest(tmp)
            self.assertEqual([f["path"] for f in value["files"]], ["src/a.js"])
            self.assertEqual({f["path"] for f in value["exclusions"]}, {".env", "node_modules", "escape"})
            self.assertEqual(value["digest"], hashlib.sha256(json.dumps(value["files"],sort_keys=True,separators=(",", ":"),ensure_ascii=False).encode()).hexdigest())
            (root / "src/a.js").write_text("changed")
            self.assertNotEqual(value["digest"],manifest(tmp)["digest"])

    def test_command_receipt_distinguishes_pre_and_post_source_and_tool_versions(self):
        saved = {}
        with patch.object(command,"manifest",side_effect=[{"digest":"before"},{"digest":"after"}]):
            result = command.execute({"command":"printf tested"},lambda p,d:saved.update({p:d}))
        receipt=json.loads(saved[result["receipt"]])
        self.assertFalse(receipt["source_unchanged"])
        self.assertEqual(receipt["source_before"]["digest"],"before")
        self.assertEqual(receipt["command"],"printf tested")
        self.assertIn("python",receipt["versions"])

if __name__ == "__main__": unittest.main()
