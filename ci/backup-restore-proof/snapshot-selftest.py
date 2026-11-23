#!/usr/bin/env python3
"""Focused snapshot contract proof on the disposable loopback service."""

import os
from pathlib import Path
import runpy
import secrets
import subprocess
import sys
import tempfile
from unittest.mock import patch

from run import Databases, ROOT

capture = runpy.run_path(str(ROOT / "bin/backup/snapshot_capture.py"))


def check(condition):
    if not condition:
        raise ValueError("synthetic snapshot proof failed")


def proof(db, scratch):
    source, target = db.create("snapshot"), db.create("restored")
    db.sql(source, (ROOT / "test/fixtures/backup-restore/snapshot.sql").read_text())
    plan = {"source": "synthetic", "host": "127.0.0.1", "port": db.env["PGPORT"],
            "database": source, "role": "agent_test", "databaseOid": int(db.created[source]),
            "archiveKey": "proof/synthetic-synthetic-20260101T000000Z.dump",
            "ranges": {"events": [4, 6], "rsvps": [8, 10]}}
    key = secrets.token_bytes(32)
    expected, key_file, bundle = (scratch / name for name in ("expected", "key", "bundle"))
    key_file.write_bytes(key)
    url = f"postgres://agent_test@127.0.0.1:{plan['port']}/{source}?sslmode=disable"
    real_run = subprocess.run

    def invoke(candidate, name):
        expected.write_bytes(capture["packed"](candidate))
        result = real_run([sys.executable, str(ROOT / "bin/backup/snapshot_capture.py"),
                           str(expected), str(key_file), str(scratch / name)],
                          env={"PATH": db.env["PATH"], "DATABASE_URL": url}, capture_output=True, timeout=15)
        check(result.returncode == 1 and result.stdout == b"" and result.stderr == b"snapshot capture: REFUSED\n")
        check(not (scratch / name).exists() and not list(scratch.glob(".snapshot-*")))

    invoke({**plan, "database": target}, "wrong-database")
    invoke({**plan, "databaseOid": plan["databaseOid"] + 1}, "wrong-oid")
    invoke({**plan, "ranges": {**plan["ranges"], "rsvps": [11, 12]}}, "empty-cohort")

    def mutate_before_dump(argv, **kwargs):
        if argv[0] == "pg_dump":
            db.sql(source, "UPDATE public.rsvps SET status='maybe' WHERE id=9")
        return real_run(argv, **kwargs)

    with patch("subprocess.run", mutate_before_dump):
        capture["capture"](plan, key, url, bundle)
    archive, receipt = bundle / "archive.dump", bundle / "baseline.json"
    db.restore(target, archive)
    check(db.sql(source, "SELECT status FROM public.rsvps") == "maybe")
    check(db.sql(target, "SELECT status FROM public.rsvps") == "going")
    target_env = {**db.env, "PGDATABASE": target}
    compare = capture["compare"]
    check(compare(plan, key, archive, receipt, target_env) == "MATCH")
    check(compare({**plan, "archiveKey": "another"}, key, archive, receipt, target_env) == "REFUSED")
    db.sql(target, "UPDATE public.events SET sync_revision=sync_revision-1 WHERE id=5")
    check(compare(plan, key, archive, receipt, target_env) == "MISMATCH")
    with archive.open("ab") as stream:
        stream.write(b"changed")
    check(compare(plan, key, archive, receipt, target_env) == "REFUSED")

    def invalid_snapshot(argv, **kwargs):
        if argv[0] == "pg_dump":
            argv = ["--snapshot=00000000-00000000-1" if arg.startswith("--snapshot=") else arg for arg in argv]
        return real_run(argv, **kwargs)

    with patch("subprocess.run", invalid_snapshot):
        try:
            capture["capture"](plan, key, url, scratch / "invalid-snapshot")
        except subprocess.CalledProcessError:
            check(not (scratch / "invalid-snapshot").exists() and not list(scratch.glob(".snapshot-*")))
        else:
            check(False)


def main():
    os.umask(0o077)
    try:
        port = str(int(sys.argv[1])) if len(sys.argv) == 2 else "5432"
        env = {"PATH": os.environ["PATH"], "PGHOST": "127.0.0.1", "PGPORT": port,
               "PGUSER": "agent_test", "PGDATABASE": "agent_test", "PGCONNECT_TIMEOUT": "5",
               "PGSSLMODE": "disable", "PGPASSFILE": "/dev/null"}
        with tempfile.TemporaryDirectory(prefix="snapshot-proof-") as parent:
            db = Databases({tool: tool for tool in ("psql", "pg_restore")}, env)
            try:
                proof(db, Path(parent))
            finally:
                db.cleanup()
    except Exception:
        print("synthetic snapshot proof: FAIL", file=sys.stderr)
        return 1
    print("synthetic snapshot proof: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
