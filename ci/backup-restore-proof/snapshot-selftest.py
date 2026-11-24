#!/usr/bin/env python3
"""Focused snapshot contract proof on the disposable loopback service."""

from pathlib import Path
import runpy
import secrets
import subprocess
import sys
from unittest import TestCase
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
capture = runpy.run_path(str(ROOT / "bin/backup/snapshot_capture.py"))


def check(condition):
    if not condition:
        raise ValueError("synthetic snapshot proof failed")


def proof(db, scratch):
    source, target = db.create("snapshot"), db.create("restored")
    db.sql(source, (ROOT / "test/fixtures/backup-restore/snapshot.sql").read_text())
    plan = {"source": "synthetic", "host": "127.0.0.1", "port": db.env["PGPORT"],
            "database": source, "role": "agent_test", "databaseOid": int(db.created[source]),
            "archivePrefix": "proof/nested.prefix/synthetic-synthetic",
            "archiveKey": "proof/nested.prefix/synthetic-synthetic-20260101T000000Z.dump",
            "ranges": {"events": [1, 128], "rsvps": [8, 10]}}
    key = secrets.token_bytes(32)
    expected, key_file, bundle = (scratch / name for name in ("expected", "key", "bundle"))
    url = f"postgres://agent_test@127.0.0.1:{plan['port']}/{source}?sslmode=disable"
    real_run = subprocess.run

    def invoke(data, name, secret=key, connection=url, valid=False, path=db.env["PATH"]):
        expected.write_bytes(data)
        key_file.write_bytes(secret)
        result = real_run([sys.executable, str(ROOT / "bin/backup/snapshot_capture.py"),
                           str(expected), str(key_file), str(scratch / name)],
                          env={"PATH": path, "DATABASE_URL": connection}, capture_output=True, timeout=15)
        verdict = (0, b"snapshot capture: PASS\n", b"") if valid else (1, b"", b"snapshot capture: REFUSED\n")
        check((result.returncode, result.stdout, result.stderr) == verdict)
        check((scratch / name).exists() == valid and not list(scratch.glob(".snapshot-*")))

    packed = capture["packed"]
    raw = packed(plan)
    invoke(raw.ljust(4096), "cli-success", valid=True)
    deep_json = b"[" * 1100 + b"]" * 1100
    for data in (b"", b"{", deep_json, raw.ljust(4097), packed({**plan, "role": "other"}),
                 packed({**plan, "database": target}), packed({**plan, "databaseOid": plan["databaseOid"] + 1}),
                 packed({**plan, "ranges": {**plan["ranges"], "events": [1, 129]}}),
                 packed({**plan, "ranges": {**plan["ranges"], "rsvps": [11, 12]}})):
        invoke(data, "invalid-plan")
    prefix = plan["archivePrefix"]
    bare = prefix.rsplit("/", 1)[1]
    invoke(packed({**plan, "archivePrefix": bare, "archiveKey": bare + "-20260101T000000Z.dump"}), "bare-key")
    for suffix in ("-20260230T000000Z.dump", "-20260101T000000Z-weekly-20260102T000000Z.dump"):
        invoke(packed({**plan, "archiveKey": prefix + suffix}), "invalid-archive")
    for secret in (b"", key + b"x"):
        invoke(raw, "invalid-key", secret=secret)
    invoke(raw, "weak-tls", connection=url.replace("sslmode=disable", "sslmode=require"))
    (scratch / "pg_dump").symlink_to(ROOT / "test/fixtures/backup-restore/hangup-pg-dump.sh")
    invoke(raw, "hangup", path=f"{scratch}:{db.env['PATH']}")

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
    target_env = {**db.env, "PGDATABASE": target, "PGCLIENTENCODING": "LATIN1"}
    compare = capture["compare"]
    check(compare(plan, key, archive, receipt, target_env) == "MATCH")
    expected.write_bytes(deep_json)
    check(compare(plan, key, archive, expected, target_env) == "REFUSED")
    check(compare({**plan, "archiveKey": "another"}, key, archive, receipt, target_env) == "REFUSED")
    db.sql(target, "UPDATE public.events SET sync_revision=sync_revision-1 WHERE id=5")
    check(compare(plan, key, archive, receipt, target_env) == "MISMATCH")
    with archive.open("ab") as stream:
        stream.write(b"changed")
    check(compare(plan, key, archive, receipt, target_env) == "REFUSED")

    def invalid_snapshot(argv, **kwargs):
        invalid = "--snapshot=00000000-00000000-1"
        return real_run([invalid if arg.startswith("--snapshot=") else arg for arg in argv], **kwargs)

    for failure, effect in ((subprocess.CalledProcessError, invalid_snapshot),
                            (subprocess.TimeoutExpired, subprocess.TimeoutExpired("pg_dump", 300))):
        with patch("subprocess.run", side_effect=effect), TestCase().assertRaises(failure):
            capture["capture"](plan, key, url, scratch / "invalid-snapshot")
        check(not (scratch / "invalid-snapshot").exists() and not list(scratch.glob(".snapshot-*")))
