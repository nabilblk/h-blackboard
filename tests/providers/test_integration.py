import base64
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/"desktop/execution/guest"))
import files

class IntegrationTests(unittest.TestCase):
    def test_exact_three_way_changes_deletions_and_conflicts_preserve_inputs(self):
        with tempfile.TemporaryDirectory() as root, patch.object(files,"WORKSPACE",root):
            contents=[{"same":"a","conflict":"base","delete":"gone"}, {"same":"a","conflict":"local","delete":"gone","ours":"x"}, {"same":"b","conflict":"remote","theirs":"y"}]
            trees=[]
            for name,items in zip(["base","current","proposal"],contents):
                for path,value in items.items(): files.write(name+"/"+path,value.encode())
                trees.append({"directory":name,"paths":list(items)})
            request={"action":"integrate_project","trees":trees,"destination":"merged"}
            result=files.main(request)
            self.assertEqual(result["conflicts"],["conflict"])
            self.assertFalse(result["resolved"])
            self.assertEqual(files.read("merged/conflict"),b"local")
            self.assertEqual(files.read("merged/same"),b"b")
            self.assertEqual(files.read("merged/theirs"),b"y")
            self.assertEqual(files.read("merged/ours"),b"x")
            with self.assertRaises(FileNotFoundError):files.read("merged/delete")
            self.assertTrue(files.main(request)["replayed"])
            files.write("merged/same",b"user edit")
            with self.assertRaisesRegex(ValueError,"differs"):files.main(request)
            self.assertEqual(files.read("merged/same"),b"user edit")
            self.assertEqual(files.read("proposal/conflict"),b"remote")
    def test_malicious_paths_and_existing_symlinks_cannot_escape_destination(self):
        with tempfile.TemporaryDirectory() as root, patch.object(files,"WORKSPACE",root):
            for path in ["../escape","/absolute","a//b","a\\b"]:
                with self.assertRaises(ValueError):files.main({"action":"import_project","destination":"new","files":[{"path":path,"base64":"eA=="}]})
            pathlib.Path(root,"link").symlink_to(root,target_is_directory=True)
            with self.assertRaises(ValueError):files.main({"action":"import_project","destination":"link","files":[]})
