#!/usr/bin/env python3
"""Synthetic recoverability proof; never accepts an existing database or archive."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "test/fixtures/backup-restore/fixture.sql"
EXPECTED_COUNTS = {
    ("public", "empty_items"): 0,
    ("public", "events"): 3,
    ("public", "members"): 3,
    ("proof_extra", "notes"): 4,
}


class ProofError(Exception):
    pass


def validate_target(host, port, user, environ):
    # Reject even empty overrides before resolving/invoking any client. libpq has
    # many connection inputs (including PGHOSTADDR and PGSERVICE), not just URLs.
    if any(key.startswith("PG") or "DATABASE_URL" in key for key in environ):
        raise ProofError("inherited connection override refused")
    if user != "agent_test" or str(port) != "5432":
        raise ProofError("non-test user or port refused")
    if host != "agent-testdb" and not (
        host == "postgres"
        and environ.get("CI") == "true"
        and environ.get("GITHUB_ACTIONS") == "true"
    ):
        raise ProofError("non-test host refused")


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def command(argv, env, stage, input_text=None, allow_failure=False):
    result = subprocess.run(argv, env=env, input=input_text, capture_output=True,
                            text=True, timeout=90)
    if result.returncode and not allow_failure:
        # Client diagnostics can include connection strings or row contents.
        raise ProofError(stage + " failed (client output withheld)")
    return result


class Databases:
    def __init__(self, tools, env):
        self.tools = tools
        self.env = env
        self.token = uuid.uuid4().hex
        self.prefix = "two_web_backup_proof_" + self.token + "_"
        self.marker = "synthetic-backup-proof:" + self.token
        self.created = {}
        self.created_count = 0
        self.removed_count = 0

    def sql(self, database, sql):
        if database != "agent_test" and database not in self.created:
            raise ProofError("unowned database refused")
        return command([self.tools["psql"], "-X", "-w", "-At", "-v",
                        "ON_ERROR_STOP=1", "-c", sql],
                       {**self.env, "PGDATABASE": database}, "SQL").stdout.strip()

    def create(self, role):
        if not re.fullmatch(r"[a-z]+", role):
            raise ProofError("invalid disposable database role")
        name = self.prefix + role
        if name in self.created:
            raise ProofError("database reuse refused")
        self.sql("agent_test", "CREATE DATABASE " + ident(name) + " TEMPLATE template0")
        self.created_count += 1
        self.sql("agent_test", "COMMENT ON DATABASE " + ident(name) + " IS " + literal(self.marker))
        identity = self.identity(name)
        if not identity or identity[1:] != ["agent_test", self.marker]:
            raise ProofError("created database identity not confirmed")
        self.created[name] = identity[0]
        return name

    def identity(self, name):
        rows = self.sql("agent_test", "SELECT d.oid, r.rolname, "
                        "coalesce(shobj_description(d.oid, 'pg_database'), '') "
                        "FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba "
                        "WHERE d.datname = " + literal(name))
        return rows.split("|") if rows else None

    def cleanup(self):
        failed = False
        for name, oid in reversed(list(self.created.items())):
            try:
                if not name.startswith(self.prefix) or self.identity(name) != [
                    oid, "agent_test", self.marker
                ]:
                    failed = True
                    continue
                # No FORCE, no termination of other sessions, no prefix sweep.
                self.sql("agent_test", "DROP DATABASE " + ident(name))
                self.removed_count += 1
                del self.created[name]
            except (ProofError, subprocess.SubprocessError):
                failed = True
        if failed or self.removed_count != self.created_count:
            raise ProofError("cleanup incomplete; unidentified databases left untouched")

    def snapshot(self, name):
        inventory = self.sql(name, "SELECT n.nspname, c.relname FROM pg_class c "
                             "JOIN pg_namespace n ON n.oid=c.relnamespace "
                             "WHERE c.relkind IN ('r','p','f') "
                             "AND n.nspname <> 'information_schema' "
                             "AND n.nspname !~ '^pg_' ORDER BY 1,2")
        snapshot = {}
        for row in inventory.splitlines():
            schema, table = row.split("|")
            qualified = ident(schema) + "." + ident(table)
            count = int(self.sql(name, "SELECT count(*) FROM " + qualified))
            contents = self.sql(name, "SELECT to_jsonb(t)::text FROM " + qualified +
                                " t ORDER BY to_jsonb(t)::text COLLATE \"C\"")
            snapshot[(schema, table)] = (count, hashlib.sha256(contents.encode()).hexdigest())
        return snapshot

    def restore(self, name, archive, allow_failure=False):
        if name not in self.created:
            raise ProofError("unowned restore target refused")
        return command([self.tools["pg_restore"], "--exit-on-error", "--no-owner",
                        "--no-privileges", "--dbname=" + name, str(archive)],
                       {**self.env, "PGDATABASE": name}, "restore",
                       allow_failure=allow_failure)


def compare(expected, actual):
    if expected.keys() != actual.keys():
        raise ProofError("table inventory mismatch")
    if any(expected[table][0] != actual[table][0] for table in expected):
        raise ProofError("table count mismatch")
    if expected != actual:
        raise ProofError("deterministic contents mismatch")


def expect_mismatch(expected, actual, reason):
    try:
        compare(expected, actual)
    except ProofError as error:
        if str(error) == reason:
            return
        raise
    raise ProofError("negative control failed to detect " + reason)


def run(args):
    validate_target(args.host, args.port, args.user, os.environ)
    tools = {}
    for tool in ("psql", "pg_dump", "pg_restore", "bash", "python3"):
        tools[tool] = shutil.which(tool)
        if not tools[tool]:
            raise ProofError("required tool missing: " + tool)
    scratch_parent = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
    with tempfile.TemporaryDirectory(prefix="backup-restore-proof-", dir=scratch_parent) as scratch:
        scratch = Path(scratch)
        # A clean environment also isolates HOME/.pgpass, shell startup scripts,
        # Cloudflare auth, backup overrides and libpq config from the backup CLI.
        env = {
            "PATH": os.environ.get("PATH", os.defpath), "HOME": str(scratch),
            "TMPDIR": str(scratch), "LC_ALL": "C", "TZ": "UTC",
            "PGHOST": args.host, "PGPORT": "5432", "PGUSER": "agent_test",
            "PGPASSWORD": "", "PGDATABASE": "agent_test",
            "PGPASSFILE": "/dev/null", "PGSERVICEFILE": "/dev/null",
            "PGSYSCONFDIR": str(scratch), "PGCONNECT_TIMEOUT": "5",
            "PGOPTIONS": "-c statement_timeout=30000 -c lock_timeout=5000",
        }
        # Supports clients unpacked locally instead of a host package install.
        if "LD_LIBRARY_PATH" in os.environ:
            env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
        db = Databases(tools, env)
        try:
            source = db.create("source")
            db.sql(source, FIXTURE.read_text())
            expected = db.snapshot(source)
            if {key: value[0] for key, value in expected.items()} != EXPECTED_COUNTS:
                raise ProofError("source fixture inventory/counts unexpected")
            fake = Path(__file__).with_name("fake-r2.py")
            fake_env = {**env, "FAKE_R2_ROOT": str(scratch / "r2"),
                        "WRANGLER_BIN": str(fake), "BACKUP_BUCKET": "synthetic-proof",
                        "BACKUP_PREFIX": "proof", "BACKUP_JURISDICTION": "eu",
                        "DATABASE_URL": f"postgres://agent_test@{args.host}:5432/{source}"}
            command([tools["bash"], str(ROOT / "bin/neon-backup.sh"), "backup", "synthetic"],
                    fake_env, "backup CLI")
            manifest = scratch / "manifest.txt"
            command([str(fake), "r2", "object", "get",
                     "synthetic-proof/proof/synthetic-synthetic/MANIFEST.txt",
                     "--file", str(manifest), "--remote", "--jurisdiction", "eu"],
                    fake_env, "manifest download")
            keys = manifest.read_text().splitlines()
            if len(keys) != 1 or not re.fullmatch(
                r"proof/synthetic-synthetic-\d{8}T\d{6}Z\.dump", keys[0]
            ):
                raise ProofError("synthetic manifest unexpected")
            archive = scratch / "downloaded.dump"
            command([str(fake), "r2", "object", "get", "synthetic-proof/" + keys[0],
                     "--file", str(archive), "--remote", "--jurisdiction", "eu"],
                    fake_env, "archive download")
            good = db.create("valid")
            db.restore(good, archive)
            compare(expected, db.snapshot(good))
            print("PASS round-trip: tables=4 rows=10 inventory/counts/contents equal")

            truncated = scratch / "truncated.dump"
            truncated.write_bytes(archive.read_bytes()[:64])
            bad = db.create("truncated")
            if db.restore(bad, truncated, allow_failure=True).returncode == 0:
                raise ProofError("truncated archive accepted")
            print("PASS negative-control: truncated archive rejected by pg_restore")
            for role, sql, reason in (
                ("missing", "DROP TABLE public.empty_items", "table inventory mismatch"),
                ("extra", "CREATE TABLE proof_extra.unexpected (id integer)", "table inventory mismatch"),
                ("count", "DELETE FROM public.events WHERE id=3", "table count mismatch"),
                ("changed", "UPDATE public.members SET label='changed' WHERE id=1", "deterministic contents mismatch"),
            ):
                target = db.create(role)
                db.restore(target, archive)
                db.sql(target, sql)
                expect_mismatch(expected, db.snapshot(target), reason)
                print("PASS negative-control: " + role + " detected")
        finally:
            db.cleanup()
            print(f"PASS cleanup: created={db.created_count} removed={db.removed_count}")
    print("synthetic restore proof: PASS (no live archives or remote R2)")


def main():
    class SafeParser(argparse.ArgumentParser):
        def error(self, message):
            self.exit(2, "synthetic restore proof: FAIL: unsupported arguments refused\n")
    parser = SafeParser(description=__doc__)
    parser.add_argument("--host", default="agent-testdb")
    parser.add_argument("--port", default="5432")
    parser.add_argument("--user", default="agent_test")
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise ProofError("interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        run(args)
    except (ProofError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, ProofError) else "execution interrupted or client unavailable"
        print("synthetic restore proof: FAIL: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
