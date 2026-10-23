"""Boundary tests for byte-preserving artifact import; no models or host files."""
import base64
import copy
import hashlib
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
from artifact_io import import_artifact, import_project, publication_context, publication_preflight, CHUNK, MAX_FILE


class Transfer:
    def __init__(self, data=b"{\n  \"value\": 42\n}\n"):
        self.data = data
        self.revision = "a" * 64
        self.digest = "b" * 64  # Host-verified BLAKE3; no digest verification mock claim.
        self.args = {"revision": self.revision, "path": "data.json", "destination": "review/data.json"}
        self.calls, self.writes = [], []
        self.modify = lambda value, operation: value
        self.permission = {"allowed": True}

    def board(self, tool, args):
        self.calls.append((tool, args))
        if tool == "check_permission":
            return self.permission
        operation = args["operation"]
        if operation["type"] == "artifact_detail":
            value = {"revision": self.revision, "document": {"files": [
                {"path": "data.json", "size": len(self.data), "hash": self.digest}]}}
        else:
            offset = operation["transfer"]["offset"]
            chunk = self.data[offset:offset + CHUNK]
            end = offset + len(chunk)
            value = {"hex": chunk.hex(), "offset": end, "complete": end == len(self.data),
                     "size": len(self.data), "hash": self.digest}
        return self.modify(value, operation)

    def files(self, request):
        self.writes.append(request)
        return {"path": request["path"], "size": len(base64.b64decode(request["base64"]))}

    def run(self):
        return import_artifact(self.args, self.board, self.files)


class ArtifactImportTests(unittest.TestCase):
    def test_scoped_transfer_retains_native_error_code_and_retryability(self):
        f = Transfer()
        f.modify = lambda value, operation: {"error":"Required bytes have not arrived.","code":"history_incomplete","retryable":True}
        with self.assertRaises(ValueError) as failure: f.run()
        self.assertEqual(failure.exception.code,"history_incomplete")
        self.assertTrue(failure.exception.retryable)
        self.assertEqual(f.writes,[])

    def test_exact_binary_and_multichunk_transfer_with_small_receipt(self):
        f = Transfer(bytes(range(256)) * 500)
        receipt = f.run()
        self.assertEqual(len(f.writes), 1)
        self.assertEqual(base64.b64decode(f.writes[0]["base64"]), f.data)
        self.assertEqual(receipt["sha256"], hashlib.sha256(f.data).hexdigest())
        self.assertEqual(receipt["blake3"], f.digest)
        self.assertEqual(receipt["destination"], f.args["destination"])
        self.assertEqual([c[1]["operation"]["transfer"]["offset"] for c in f.calls
                          if c[1].get("operation", {}).get("type") == "artifact_transfer"],
                         [0, CHUNK, CHUNK * 2])
        self.assertNotIn("hex", receipt)
        self.assertNotIn("base64", receipt)

    def test_empty_file_preserved(self):
        f = Transfer(b"")
        self.assertEqual(f.run()["size"], 0)
        self.assertEqual(f.writes[0]["base64"], "")

    def test_invalid_paths_and_extra_authority_never_reach_board(self):
        for field in ("path", "destination"):
            for path in ("", "/etc/passwd", "../secret", "a/../b", "a//b", "a\\b", "a:b",
                         "a\0b", "a\x7fb", "x" * 241, 42):
                with self.subTest(field=field, path=path):
                    f = Transfer(); f.args[field] = path
                    with self.assertRaises(ValueError): f.run()
                    self.assertEqual(f.calls, [])
        for extra in ({"mission": "other"}, {"owner": True}, {"source": "/home/hb-runtime"}):
            f = Transfer(); f.args.update(extra)
            with self.assertRaises(ValueError): f.run()
            self.assertEqual(f.calls, [])

    def test_denied_or_changed_manifest_writes_nothing(self):
        modifiers = [
            lambda v: {"error": "Access denied"},
            lambda v: {**v, "revision": "c" * 64},
            lambda v: {**v, "document": {"files": []}},
            lambda v: {**v, "document": {"files": v["document"]["files"] * 2}},
        ]
        for field, value in (("size", MAX_FILE + 1), ("size", -1), ("size", True),
                             ("hash", "invalid")):
            def modified(v, field=field, value=value):
                v = copy.deepcopy(v); v["document"]["files"][0][field] = value
                return v
            modifiers.append(modified)
        for i, modify in enumerate(modifiers):
            with self.subTest(i=i):
                f = Transfer(); f.modify = lambda v, op: modify(v) if op["type"] == "artifact_detail" else v
                with self.assertRaises(ValueError): f.run()
                self.assertEqual(f.writes, [])

    def test_bad_chunks_and_midtransfer_revocation_never_write(self):
        for patch in ({"error": "Revoked"}, {"hash": "c" * 64}, {"size": 1},
                      {"size": True}, {"offset": 0}, {"offset": True}, {"complete": True},
                      {"complete": 0}, {"hex": ""}, {"hex": "0"}, {"hex": "gg"},
                      {"hex": "00 "}, {"hex": "00" * (CHUNK + 1)}):
            with self.subTest(patch=str(patch)[:80]):
                f = Transfer(b"x" * (CHUNK + 1))
                f.modify = lambda v, op: {**v, **patch} if op["type"] == "artifact_transfer" else v
                with self.assertRaises(ValueError): f.run()
                self.assertEqual(f.writes, [])

    def test_permission_rechecked_before_final_write(self):
        for permission in ({"error": "Paused"}, {"allowed": False}, {}):
            f = Transfer(); f.permission = permission
            with self.assertRaises(ValueError): f.run()
            self.assertEqual(f.writes, [])
            self.assertEqual(f.calls[-1], ("check_permission", {}))

    def test_worker_filesystem_denial_propagates(self):
        f = Transfer()
        with self.assertRaisesRegex(ValueError, "Denied"):
            import_artifact(f.args, f.board, lambda _: {"error": "Denied"})


class PublicationTests(unittest.TestCase):
    def test_new_publication_uses_workstream_but_existing_lineage_is_never_guessed(self):
        control, stream = "a" * 64, "b" * 64
        def board(tool, args):
            if args["operation"]["type"] == "artifact_detail":
                return {"artifact":{"conversation":"private:"+stream}}
            return {"lifecycle":{"revision":control},"agent":{"assignment":{"workstream":stream}}}
        value = publication_context({"document":{}},board)
        self.assertEqual(value["conversation"],"workstream:"+stream)
        self.assertEqual(value["control"],control)
        self.assertEqual(value["parents"],[])
        self.assertEqual(publication_context({"conversation":"main"},board)["conversation"],"main")
        with self.assertRaisesRegex(ValueError,"parent revisions"):
            publication_context({"artifact":"c"*64},board)
        revised = publication_context({"artifact":"c"*64,"parents":["d"*64]},board)
        self.assertEqual(revised["conversation"],"private:"+stream)
        self.assertEqual(revised["parents"],["d"*64])

    def test_project_is_written_only_when_every_file_and_permission_pass(self):
        for failure in (None, "second-file", "permission"):
            writes=[]
            def board(tool,args):
                if tool=="check_permission":
                    return {"allowed":failure!="permission"}
                operation=args["operation"]
                if operation["type"]=="artifact_detail":
                    return {"revision":"a"*64,"document":{"files":[{"path":p,"size":1,"hash":"b"*64} for p in ("index.html","src/data.json")]}}
                if failure=="second-file" and operation["transfer"]["path"]=="src/data.json":
                    return {"error":"Transfer failed"}
                return {"hex":"78","offset":1,"complete":True,"size":1,"hash":"b"*64}
            def files(request):
                writes.append(request)
                return {"imported":2}
            args={"revision":"a"*64,"destination":"review/project"}
            if failure:
                with self.assertRaises(ValueError): import_project(args,board,files)
                self.assertEqual(writes,[])
            else:
                result=import_project(args,board,files)
                self.assertEqual(len(writes),1)
                self.assertEqual(writes[0]["action"],"import_project")
                self.assertEqual([f["path"] for f in writes[0]["files"]],["index.html","src/data.json"])
                self.assertEqual(len(result["files"]),2)

    def test_lineage_error_precedes_upload(self):
        calls = []
        root, current, wrong = "a" * 64, "b" * 64, "c" * 64
        def board(tool, args):
            calls.append(args)
            return {"artifact": {"id": root, "heads": [current]}}
        args = {"artifact": root, "parents": [wrong], "paths": ["index.html"], "document": {"entrypoint": "index.html", "inputs": []}}
        with self.assertRaisesRegex(ValueError, "Parents"):
            publication_preflight(args, board)
        self.assertEqual(len(calls), 1)
        args["parents"] = [current]
        publication_preflight(args, board)
        args["document"]["inputs"] = [current]
        with self.assertRaisesRegex(ValueError, "own earlier version"):
            publication_preflight(args, board)


if __name__ == "__main__":
    unittest.main()
