#!/usr/bin/env python3
"""No-network refusal, comparison and cleanup regressions; stdlib only."""

import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("proof", HERE / "run.py")
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class RefusalTests(unittest.TestCase):
    def test_refusals_before_client_invocation(self):
        cases = [
            (["--host", "production.example"], {}),
            (["--host", "next.togetherweown.com"], {}),
            (["--host", "localhost"], {}),
            (["--host", "postgres"], {"CI": "true"}),
            (["--host", "agent-testdb.evil.example"], {}),
            (["--user", "postgres"], {}),
            (["--port", "5433"], {}),
            (["--database", "paperclip"], {}),
            (["--database", "postgres://refusal-test-marker@production.example/paperclip"], {}),
            (["--host", "localhost"], {"CI": "true", "GITHUB_ACTIONS": "true"}),
            (["--host", "127.0.0.1"], {"CI": "true", "GITHUB_ACTIONS": "true"}),
        ]
        for name in ("DATABASE_URL", "NEON_STAGING_DATABASE_URL",
                     "AUDIT_IMPORT_TEST_DATABASE_URL", "PGHOST", "PGHOSTADDR",
                     "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD", "PGSERVICE",
                     "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS", "PGSYSCONFDIR"):
            cases.append(([], {name: "refusal-test-marker"}))
            cases.append(([], {name: ""}))
        with tempfile.TemporaryDirectory(dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")) as tmp:
            tmp = Path(tmp)
            sentinel = tmp / "client-called"
            for tool in ("psql", "pg_dump", "pg_restore"):
                path = tmp / tool
                path.write_text("#!/bin/sh\nprintf called >> " + shlex.quote(str(sentinel)) + "\nexit 77\n")
                path.chmod(0o755)
            env = {"PATH": str(tmp) + os.pathsep + os.defpath,
                   "HOME": str(tmp), "SENTINEL": str(sentinel)}
            for args, overrides in cases:
                with self.subTest(args=args, variable=list(overrides)):
                    result = subprocess.run([sys.executable, str(HERE / "run.py"), *args],
                                            env={**env, **overrides}, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(sentinel.exists(), "database client invoked before refusal")
                    self.assertNotIn("refusal-test-marker", result.stdout + result.stderr)
            # Prove the sentinel itself works even in the scrubbed child env.
            result = subprocess.run([sys.executable, str(HERE / "run.py")], env=env,
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(sentinel.exists())

    def test_exact_allowlist(self):
        proof.validate_target("agent-testdb", "5432", "agent_test", {})
        proof.validate_target("postgres", "5432", "agent_test",
                              {"CI": "true", "GITHUB_ACTIONS": "true"})
        for host in ("localhost", "127.0.0.1", "production.example"):
            with self.assertRaises(proof.ProofError):
                proof.validate_target(host, "5432", "agent_test",
                                      {"CI": "true", "GITHUB_ACTIONS": "true"})


class ComparisonTests(unittest.TestCase):
    def test_valid(self):
        expected = {("public", "empty"): (0, "hash"), ("extra", "notes"): (2, "rows")}
        proof.compare(expected, dict(reversed(list(expected.items()))))

    def test_inventory_counts_and_content(self):
        expected = {("public", "empty"): (0, "hash"), ("extra", "notes"): (2, "rows")}
        cases = [
            ({("extra", "notes"): (2, "rows")}, "table inventory mismatch"),
            ({**expected, ("other", "new"): (0, "hash")}, "table inventory mismatch"),
            ({**expected, ("extra", "notes"): (1, "rows")}, "table count mismatch"),
            ({**expected, ("extra", "notes"): (2, "changed")}, "deterministic contents mismatch"),
        ]
        for actual, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(proof.ProofError, reason):
                    proof.compare(expected, actual)
                proof.expect_mismatch(expected, actual, reason)
        with self.assertRaises(proof.ProofError):
            proof.expect_mismatch(expected, expected, "table inventory mismatch")


class TransportTests(unittest.TestCase):
    def test_local_put_get_and_missing_object(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")) as tmp:
            tmp = Path(tmp)
            source, downloaded = tmp / "input", tmp / "downloaded"
            source.write_bytes(b"synthetic transport fixture\x00\xff")
            env = {"PATH": os.defpath, "FAKE_R2_ROOT": str(tmp / "objects")}
            key = "synthetic-proof/proof/synthetic-synthetic-20250101T000000Z.dump"
            def invoke(operation, key, file):
                return subprocess.run([sys.executable, str(HERE / "fake-r2.py"),
                                       "r2", "object", operation, key, "--file", str(file),
                                       "--remote", "--jurisdiction", "eu"], env=env,
                                      capture_output=True)
            self.assertEqual(invoke("put", key, source).returncode, 0)
            result = invoke("get", key, downloaded)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(downloaded.read_bytes(), source.read_bytes())
            self.assertEqual(result.stdout, b"")
            self.assertNotEqual(invoke("get", key.replace("20250101", "20250102"), downloaded).returncode, 0)
            # The pipeline publishes the archive with its digest receipt pair.
            receipt_key = key + ".digest.json"
            self.assertEqual(invoke("put", receipt_key, source).returncode, 0)
            self.assertEqual(invoke("get", receipt_key, downloaded).returncode, 0)
            for unsafe in ("live-bucket/backup.dump", "synthetic-proof/../../escape",
                           "synthetic-proof/proof/staging-staging/MANIFEST.txt",
                           key + ".digest", "synthetic-proof/proof/synthetic-synthetic/"
                                            "20250101T000000Z.dump.digest.json"):
                self.assertNotEqual(invoke("put", unsafe, source).returncode, 0)
            self.assertEqual(len(list((tmp / "objects").rglob("*.dump"))), 1)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.db = proof.Databases({"psql": "unused"}, {})
        self.name = self.db.prefix + "source"
        self.db.created = {self.name: "123"}
        self.db.created_count = 1

    def test_owned_database_only(self):
        with patch.object(self.db, "identity", return_value=["123", "agent_test", self.db.marker]), \
                patch.object(self.db, "sql") as sql:
            self.db.cleanup()
        sql.assert_called_once_with("agent_test", 'DROP DATABASE "' + self.name + '"')
        self.assertEqual(self.db.removed_count, 1)

    def test_replaced_unmarked_or_different_owner_not_dropped(self):
        for identity in (None, ["456", "agent_test", self.db.marker],
                         ["123", "postgres", self.db.marker], ["123", "agent_test", "other"]):
            with self.subTest(identity=identity), \
                    patch.object(self.db, "identity", return_value=identity), \
                    patch.object(self.db, "sql") as sql:
                with self.assertRaisesRegex(proof.ProofError, "cleanup incomplete"):
                    self.db.cleanup()
                sql.assert_not_called()

    def test_non_unique_name_not_dropped(self):
        self.db.created = {"agent_test": "123"}
        with patch.object(self.db, "sql") as sql:
            with self.assertRaises(proof.ProofError):
                self.db.cleanup()
            sql.assert_not_called()

    def test_failed_create_never_registered_for_cleanup(self):
        with patch.object(self.db, "sql", side_effect=proof.ProofError("CREATE failed")):
            with self.assertRaises(proof.ProofError):
                self.db.create("valid")
        self.assertEqual(self.db.created, {self.name: "123"})
        self.assertEqual(self.db.created_count, 1)

    def test_restore_and_queries_refuse_unowned_database(self):
        with patch.object(proof, "command") as command:
            with self.assertRaises(proof.ProofError):
                self.db.sql("paperclip", "SELECT 1")
            with self.assertRaises(proof.ProofError):
                self.db.restore("paperclip", "unused.dump")
            command.assert_not_called()

    def test_client_diagnostics_are_withheld(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 1, "private contents", "private connection")):
            with self.assertRaisesRegex(proof.ProofError, "client output withheld") as result:
                proof.command([], {}, "restore")
        self.assertNotIn("private", str(result.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
