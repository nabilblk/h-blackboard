"""The guest runtime receives explicit policy, not inherited process settings."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
from runtimes import environment


class RuntimeEnvironmentTests(unittest.TestCase):
    def test_private_memory_and_subagents_stay_off_without_inheriting_secrets(self):
        with patch.dict(os.environ, {
            "GROK_MEMORY": "1",
            "GROK_SUBAGENTS": "1",
            "XAI_API_KEY": "test-only-parent-credential",
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0",
        }):
            configured = environment()
            self.assertEqual(configured["GROK_MEMORY"], "0")
            self.assertEqual(configured["GROK_SUBAGENTS"], "0")
            self.assertEqual(configured["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1")
            self.assertNotIn("XAI_API_KEY", configured)
            self.assertEqual(os.environ["GROK_MEMORY"], "1")


if __name__ == "__main__":
    unittest.main()
