#!/usr/bin/env python3
"""Opt-in local capture and private comparison for snapshot-bound backups."""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import runpy
import select
import signal
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
connection_env = runpy.run_path(str(HERE / "connection-helper"))["connection_env"]
archive_receipt = runpy.run_path(str(HERE / "integrity-helper"))["expected_receipt"]
admit_manifest = runpy.run_path(str(HERE / "manifest-helper"))["admit"]
BEGIN = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path = pg_catalog; "
         "SET LOCAL row_security = off;\n")
PSQL = ["psql", "-XqwAt", "-v", "ON_ERROR_STOP=1"]
DUMP_TIMEOUT = 300
# Field order is part of the receipt version. '?' marks nullable fields.
FIELDS = {
    "events": "id:integer starts_at:timestamptz ends_at:timestamptz status:text rsvp_open:boolean "
              "capacity:integer? sync_revision:bigint synced_revision:bigint",
    "rsvps": "id:integer event_id:integer user_id:text status:text created_at:timestamptz "
             "legacy_id:bigint? synced_to_discord_at:timestamptz?",
}


def require(condition):
    if not condition:
        raise ValueError("snapshot evidence refused")


def packed(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def mac(key, domain, *values):
    digest = hmac.new(key, domain, hashlib.sha256)
    for value in values:
        data = packed(value)
        digest.update(len(data).to_bytes(4, "big"))
        digest.update(data)
    return digest


def private_read(path, limit):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077)
        data = stream.read(limit + 1)
        require(len(data) <= limit)
        return data


def unique_object(items):
    result = dict(items)
    require(len(items) == len(result))
    return result


def load_plan(path, key_path):
    plan = json.loads(private_read(path, 4096), object_pairs_hook=unique_object)
    require(isinstance(plan, dict))
    require(set(plan) == {"source", "host", "port", "database", "role", "databaseOid", "archiveKey", "ranges"})
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", plan["source"]))
    daily = re.fullmatch(r"(.+)-[0-9]{8}T[0-9]{6}Z\.dump", plan["archiveKey"])
    require(daily)
    admit_manifest(daily[1], [plan["archiveKey"]])
    require(type(plan["databaseOid"]) is int and 0 < plan["databaseOid"] < 2**32)
    require(isinstance(plan["ranges"], dict) and set(plan["ranges"]) == set(FIELDS))
    for bounds in plan["ranges"].values():
        require(isinstance(bounds, list) and len(bounds) == 2)
        low, high = bounds
        require(type(low) is type(high) is int and 0 < low <= high < 2**31 and high - low < 128)
    key = private_read(key_path, 32)
    require(len(key) == 32)
    return plan, key


def source_env(plan, url):
    settings = connection_env(url)
    for field, setting in (("host", "PGHOST"), ("port", "PGPORT"),
                           ("database", "PGDATABASE"), ("role", "PGUSER")):
        require(settings[setting] == plan[field])
    if settings.get("PGSSLMODE") == "disable":
        require(plan["host"] == "127.0.0.1" and plan["role"] == "agent_test")
        require(re.fullmatch(r"two_web_backup_proof_[0-9a-f]{32}_snapshot", plan["database"]))
    else:
        require(settings.get("PGSSLMODE") == "verify-full")
        settings.update(PGSSLROOTCERT="system", PGSSLCERTMODE="disable")
    return {"PATH": os.environ.get("PATH", os.defpath), **settings, "PGGSSENCMODE": "disable",
            "PGCONNECT_TIMEOUT": "5", "PGCLIENTENCODING": "UTF8"}


def probe_sql(table, fields, low, high):
    projection = []
    for column, sql_type in fields:
        if sql_type.rstrip("?") == "timestamptz":
            column = f"(extract(epoch FROM {column}) * 1000000)::numeric(30,0)"
        elif sql_type == "text":
            column = f"CASE WHEN octet_length({column}) <= 1024 THEN {column} END"
        projection.append(column)
    names = "ARRAY[" + ",".join(f"'{name}'" for name, _ in fields) + "]"
    return rf"""
\set probe_low {low:d}
\set probe_high {high:d}
WITH projected AS (
  SELECT id, json_build_array({', '.join(projection)}) AS payload
  FROM ONLY public.{table} WHERE id BETWEEN :'probe_low'::integer AND :'probe_high'::integer ORDER BY id LIMIT 129
)
SELECT json_build_array(
  (SELECT array_agg(atttypid::regtype::text ORDER BY array_position({names}, attname::text))
   FROM pg_attribute WHERE attrelid = 'public.{table}'::regclass AND attname::text = ANY({names})
   AND NOT attisdropped),
  EXISTS (SELECT FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid
    AND a.attnum = i.indkey[0] AND a.attname = 'id' WHERE i.indrelid = 'public.{table}'::regclass
    AND i.indisprimary AND i.indisvalid AND i.indnkeyatts = 1),
  CASE WHEN sum(octet_length(payload::text)+2) <= 1048574 THEN json_agg(payload ORDER BY id) END
) FROM projected;
"""


def baseline_sql(plan):
    return "".join(probe_sql(table, [item.split(":") for item in spec.split()], *plan["ranges"][table])
                   for table, spec in FIELDS.items())


def typed(value, sql_type):
    kind = sql_type.rstrip("?")
    if value is None:
        require(sql_type.endswith("?"))
        return ["null"]
    expected = {"integer": int, "bigint": int, "timestamptz": int, "boolean": bool, "text": str}
    require(type(value) is expected[kind])
    return [kind, str(value) if type(value) is int else value]


def baseline(plan, key, output):
    lines = output.split(b"\n")
    require(len(lines) == len(FIELDS) + 1 and lines[-1] == b"")
    result = {}
    for (table, spec), line in zip(FIELDS.items(), lines):
        low, high = plan["ranges"][table]
        types = [field.split(":")[1] for field in spec.split()]
        actual_types, indexed, rows = json.loads(line)
        require(actual_types == [t.rstrip("?").replace("timestamptz", "timestamp with time zone")
                                 for t in types] and indexed is True)
        require(isinstance(rows, list) and 0 < len(rows) <= high - low + 1)
        digest = mac(key, b"web-backup-projection-v1", plan, table, spec)
        previous = low - 1
        for row in rows:
            require(isinstance(row, list) and len(row) == len(types))
            require(type(row[0]) is int and previous < row[0] <= high)
            previous = row[0]
            for value, sql_type in zip(row, types):
                token = packed(typed(value, sql_type))
                digest.update(len(token).to_bytes(4, "big") + token)
        count = packed(len(rows))
        digest.update(len(count).to_bytes(4, "big") + count)
        result[table] = {"count": len(rows), "hmac": digest.hexdigest()}
    return result


def transaction_env(env):
    return {**env, "PGCLIENTENCODING": "UTF8", "PGOPTIONS": "-c statement_timeout=2000 -c lock_timeout=250 "
            f"-c idle_in_transaction_session_timeout={(DUMP_TIMEOUT + 20) * 1000}"}


@contextmanager
def exporter(plan, env):
    with subprocess.Popen(PSQL, env=transaction_env(env), stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            process.stdin.write((BEGIN + "LOCK TABLE ONLY public.events, ONLY public.rsvps IN ACCESS SHARE MODE;\n"
                                 "SELECT json_build_array(current_database(), session_user, current_user, oid::bigint, "
                                 "current_setting('server_encoding'), pg_export_snapshot()) FROM pg_database "
                                 "WHERE datname = current_database();\n").encode())
            process.stdin.flush()
            require(select.select([process.stdout], [], [], 10)[0])
            line = os.read(process.stdout.fileno(), 1024)
            require(line.endswith(b"\n"))
            database, login, role, oid, encoding, snapshot = json.loads(line)
            require((database, login, role, oid) == (plan["database"], plan["role"], plan["role"], plan["databaseOid"]))
            require(encoding == "UTF8")
            require(re.fullmatch(r"[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+", snapshot))
            yield process, snapshot
        finally:
            if process.poll() is None:
                process.kill()


@contextmanager
def locked_parent(path):
    parent = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(parent)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077)
        fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(parent)


def capture(plan, key, url, destination):
    env = source_env(plan, url)
    with locked_parent(destination.parent):
        require(not os.path.lexists(destination))
        with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=destination.parent) as pending:
            scratch = Path(pending)
            archive = scratch / "archive.dump"
            with exporter(plan, env) as (session, snapshot):
                exported_at = datetime.now(timezone.utc).isoformat()
                subprocess.run(["pg_dump", "-w", "-Fc", "--lock-wait-timeout=2000",
                                "--snapshot=" + snapshot, "-f", str(archive)], env=env, check=True,
                               timeout=DUMP_TIMEOUT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                output, _ = session.communicate((baseline_sql(plan) + "COMMIT;\n").encode(), timeout=10)
                require(session.returncode == 0)
                content = baseline(plan, key, output)
            integrity = archive_receipt(archive, plan["archiveKey"])
            receipt = {"version": 1, "archive": integrity, "baseline": content,
                       "snapshotRef": mac(key, b"web-backup-snapshot-v1", plan, snapshot, integrity).hexdigest(),
                       "exportedAt": exported_at}
            (scratch / "archive.digest.json").write_bytes(packed(integrity) + b"\n")
            seal = mac(key, b"web-backup-receipt-v1", plan, receipt).hexdigest()
            (scratch / "baseline.json").write_bytes(packed({"receipt": receipt, "seal": seal}) + b"\n")
            scratch.rename(destination)


def compare(plan, key, archive, receipt_path, target_env):
    """Compare a caller-qualified, fenced restore target. Return only a verdict."""
    try:
        record = json.loads(private_read(receipt_path, 4096), object_pairs_hook=unique_object)
        receipt = record["receipt"]
        require(hmac.compare_digest(record["seal"], mac(key, b"web-backup-receipt-v1", plan, receipt).hexdigest()))
        require(receipt["version"] == 1 and receipt["archive"] == archive_receipt(archive, plan["archiveKey"]))
        result = subprocess.run(PSQL, env=transaction_env(target_env),
                                input=(BEGIN + baseline_sql(plan) + "COMMIT;\n").encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True)
        same = hmac.compare_digest(packed(receipt["baseline"]), packed(baseline(plan, key, result.stdout)))
    except (OSError, ValueError, TypeError, KeyError, RecursionError, subprocess.SubprocessError):
        return "REFUSED"
    return "MATCH" if same else "MISMATCH"


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    signal.signal(signal.SIGHUP, signal.default_int_handler)
    try:
        expected, key_file, output = map(Path, sys.argv[1:])
        plan, key = load_plan(expected, key_file)
        capture(plan, key, os.environ.get("DATABASE_URL", ""), output)
    except (OSError, ValueError, TypeError, KeyError, RecursionError, subprocess.SubprocessError, KeyboardInterrupt):
        print("snapshot capture: REFUSED", file=sys.stderr)
        return 1
    print("snapshot capture: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
