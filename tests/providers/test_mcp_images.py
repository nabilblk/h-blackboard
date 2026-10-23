"""The real guest transport must deliver pictures as image content, not prose."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
from mcp import tool_result


class ImageTransportTests(unittest.TestCase):
    def test_browser_image_is_native_mcp_content_and_evidence_is_text(self):
        value = {"revision": "a" * 64, "saved": ["review.jpg"],
                 "image": {"mimeType": "image/jpeg", "data": "/9j/TEST"}}
        result = tool_result("artifact_browser", value)
        self.assertEqual(result["content"][1], {"type": "image", **value["image"]})
        self.assertIn("review.jpg", result["content"][0]["text"])
        self.assertNotIn("/9j/TEST", result["content"][0]["text"])
        self.assertFalse(result["isError"])
        self.assertIn("image", value)  # Do not consume a shared response.

    def test_unbounded_or_unexpected_images_are_never_promoted(self):
        for image in (None, "not an image", {"mimeType": "image/png", "data": "x"},
                      {"mimeType": "image/jpeg", "data": "x" * (1024 * 1024 + 1)}):
            self.assertEqual(len(tool_result("artifact_browser", {"image": image})["content"]), 1)
        self.assertEqual(len(tool_result("board", {"image": {"mimeType": "image/jpeg", "data": "x"}})["content"]), 1)
        self.assertTrue(tool_result("artifact_browser", {"error": "revoked"})["isError"])
