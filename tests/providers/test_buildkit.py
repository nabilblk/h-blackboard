"""Capability selection and removal never touch provider or workspace data."""
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
import buildkit


class BuildkitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.config = self.root / "capabilities.json"
        for name, value in {"ROOT": self.root / "kits", "BIN": self.root / "bin", "CONFIG": self.config}.items():
            p = patch.object(buildkit, name, value)
            p.start()
            self.addCleanup(p.stop)
        buildkit.BIN.mkdir()
        root = patch.object(buildkit.os, "geteuid", return_value=0)
        root.start()
        self.addCleanup(root.stop)

    def test_default_has_no_downloads(self):
        with patch.object(buildkit.urllib.request, "urlopen", side_effect=AssertionError("unexpected download")):
            buildkit.install()
        selected = json.loads((buildkit.ROOT / "selected.json").read_text())
        self.assertEqual(selected, {"pack": "general", "buildkit": None, "packages": []})
        self.assertFalse((buildkit.ROOT / buildkit.VERSION).exists())

    def test_explicit_web_then_general_preserves_unrelated_data(self):
        target = buildkit.ROOT / buildkit.VERSION
        target.mkdir(parents=True)
        manifest = {"version": buildkit.VERSION, "packages": [
            {"name": n, "version": v, "url": u, a: d}
            for n, v, u, a, d, _ in buildkit.PACKAGES]}
        (target / "manifest.json").write_text(json.dumps(manifest))
        self.config.write_text('{"pack":"web-3d"}')
        with patch.object(buildkit.urllib.request, "urlopen", side_effect=AssertionError("unneeded download")):
            buildkit.install()
        self.assertTrue((buildkit.BIN / "node").is_symlink())
        self.assertEqual(json.loads((buildkit.ROOT / "selected.json").read_text())["buildkit"], buildkit.VERSION)
        (self.root / "workspace.txt").write_text("saved work")
        (buildkit.BIN / "other").write_text("unrelated")
        # An independently installed executable must not be deleted.
        (buildkit.BIN / "npm").unlink()
        (buildkit.BIN / "npm").write_text("unrelated npm")
        self.config.write_text('{"pack":"general"}')
        buildkit.install()
        self.assertFalse(target.exists())
        self.assertFalse((buildkit.BIN / "node").is_symlink())
        self.assertEqual((buildkit.BIN / "npm").read_text(), "unrelated npm")
        self.assertEqual((self.root / "workspace.txt").read_text(), "saved work")
        self.assertEqual((buildkit.BIN / "other").read_text(), "unrelated")

    def test_unknown_pack_or_mismatching_manifest_fails_closed(self):
        self.config.write_text('{"pack":"https://untrusted.example/tools"}')
        with self.assertRaises(ValueError):
            buildkit.install()
        self.assertFalse(buildkit.ROOT.exists())
        self.config.write_text('{"pack":"web-3d"}')
        target = buildkit.ROOT / buildkit.VERSION
        target.mkdir(parents=True)
        (target / "manifest.json").write_text('{}')
        with self.assertRaises(ValueError):
            buildkit.install()
        self.assertFalse((buildkit.BIN / "node").exists())


if __name__ == "__main__":
    unittest.main()
