#!/usr/bin/env python3
"""Hosted synthetic executor with fixed inputs and a verdict-only transcript."""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shutil
import signal
import subprocess
import sys
import time

from run import Databases, FIXTURE, ProofError, ROOT, validate_target

IMAGE = "postgres:18@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc"
ISOLATION = "com.docker.network.bridge.gateway_mode_ipv4=isolated"
LABEL = "two-web.synthetic-rehearsal"
MARKER = "synthetic-service-diagnostic"
EMPTY = """SELECT NOT EXISTS (
    SELECT FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','pg_toast','information_schema','public')
    UNION ALL SELECT FROM pg_class WHERE relnamespace = 'public'::regnamespace
    UNION ALL SELECT FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    UNION ALL SELECT FROM pg_type WHERE typnamespace = 'public'::regnamespace
    UNION ALL SELECT FROM pg_extension WHERE extname <> 'plpgsql'
    UNION ALL SELECT FROM pg_largeobject_metadata
    UNION ALL SELECT FROM pg_foreign_server
    UNION ALL SELECT FROM pg_event_trigger)"""


def require(condition):
    if not condition:
        raise ProofError("hosted rehearsal condition failed")


def verdict(text):
    print(text, flush=True)


def docker(*args, env=None, check=True):
    return subprocess.run(["/usr/bin/docker", "--host=unix:///var/run/docker.sock", *args],
                          capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", **(env or {})},
                          check=check, timeout=60)


class Job:
    def __init__(self):
        validate_target("postgres", 5432, "agent_test", os.environ)
        run, attempt = (os.environ[key] for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
        require(all(re.fullmatch(r"[1-9][0-9]{0,19}", value) for value in (run, attempt)))
        self.name = f"two-web-restore-{run}-{attempt}"
        self.scratch = Path("/dev/shm") / self.name
        self.label = f"{LABEL}={self.name}"

    def resources(self):
        return [(kind, id_) for kind, flags in (("container", "-aq"), ("network", "-q"), ("volume", "-q"))
                for id_ in docker(kind, "ls", flags, "--filter", f"label={self.label}").stdout.split()]

    def clean(self):
        for kind, id_ in self.resources():
            docker(kind, "rm", *(["-f", "-v"] if kind == "container" else []), id_)
        if self.scratch.exists():
            shutil.rmtree(self.scratch)
        require(not self.resources() and not self.scratch.exists())

    @contextmanager
    def service(self):
        require(not self.resources())
        self.scratch.mkdir(mode=0o700)
        try:
            password = secrets.token_hex(32)
            docker("network", "create", "--internal", "--opt", ISOLATION, "--label", self.label, self.name)
            container = docker(
                "run", "--detach", "--name", self.name, "--label", self.label, "--network", self.name,
                "--network-alias", "postgres", "--log-driver", "none",
                "--memory", "384m", "--cpus", "1", "--pids-limit", "128",
                "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=134217728",
                "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_USER=agent_test",
                "--env", "POSTGRES_DB=agent_test", "--env", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
                IMAGE, "-c", "log_statement=none", "-c", "log_min_error_statement=panic",
                env={"POSTGRES_PASSWORD": password},
            ).stdout.strip()
            network, = json.loads(docker("network", "inspect", self.name).stdout)
            service, = json.loads(docker("container", "inspect", container).stdout)
            config, settings = service["HostConfig"], service["NetworkSettings"]
            require(network["Internal"] and network["Driver"] == "bridge"
                    and network["Options"].get(ISOLATION.split("=")[0]) == "isolated"
                    and set(network["Containers"]) == {container}
                    and set(settings["Networks"]) == {self.name})
            require(not config["PublishAllPorts"] and not config["PortBindings"]
                    and not any(settings["Ports"].values()) and config["LogConfig"]["Type"] == "none"
                    and {(m["Type"], m["Destination"]) for m in service["Mounts"]}
                    == {("tmpfs", "/var/lib/postgresql")})
            verdict("private service and zero port bindings PASS")
            (self.scratch / "container").write_text(container)
            for client in ("psql", "pg_dump", "pg_restore"):
                (self.scratch / client).symlink_to(Path(__file__).resolve().with_name("hosted-client.sh"))
            env = {"PATH": f"{self.scratch}:/usr/bin:/bin", "HOME": str(self.scratch),
                   "PGHOST": "postgres", "PGPORT": "5432", "PGUSER": "agent_test",
                   "PGPASSWORD": password, "PGSSLMODE": "disable", "PGCONNECT_TIMEOUT": "2"}
            db = Databases({"psql": str(self.scratch / "psql")}, env)
            deadline = time.monotonic() + 30
            while True:
                try:
                    require(db.sql("agent_test", "SELECT 1") == "1")
                    break
                except ProofError:
                    require(time.monotonic() < deadline)
                    time.sleep(0.5)
            rejected = client_sql({**env, "PGPASSWORD": secrets.token_hex(32)}, "SELECT 1")
            require(rejected.returncode != 0 and "password authentication failed" in rejected.stderr)
            db.sql("agent_test", f"DO $$ BEGIN RAISE LOG '{MARKER}'; END $$")
            logs = docker("logs", container, check=False)
            require(logs.returncode != 0 and not logs.stdout and MARKER not in logs.stderr)
            verdict("password authentication and service diagnostics suppression PASS")
            yield db, password
        finally:
            self.clean()
            verdict("executor teardown PASS")


def client_sql(env, sql):
    return subprocess.run(["psql", "-XqwAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
                          env={**env, "PGDATABASE": "agent_test"}, capture_output=True, text=True, timeout=10)


class Refused(ProofError):
    pass


class ExpectedRestoreFailure(ProofError):
    pass


def expect_refusal(operation):
    try:
        operation()
    except Refused:
        return
    raise ProofError("negative control accepted")


def target_env(db, expected, connected):
    identity = db.sql(connected, "SELECT current_database(), session_user, current_user, oid, "
                      "shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()")
    if identity != f"{expected}|agent_test|agent_test|{db.created[expected]}|{db.marker}":
        raise Refused("wrong target")
    if db.sql(connected, EMPTY) != "t":
        raise Refused("nonempty target")
    return {**db.env, "PGDATABASE": connected}


def proof(db, password, scratch, mode):
    snapshot = runpy.run_path(str(ROOT / "bin/backup/snapshot_capture.py"))
    verify_receipt = runpy.run_path(str(ROOT / "bin/backup/integrity-helper"))["verify_receipt"]
    source, target = db.create("snapshot"), db.create("restored")
    db.sql(source, FIXTURE.with_name("snapshot.sql").read_text())
    prefix = "proof/synthetic-synthetic"
    plan = {"source": "hosted-synthetic", "host": "127.0.0.1", "port": "5432",
            "role": "agent_test", "database": source, "databaseOid": int(db.created[source]),
            "archivePrefix": prefix, "archiveKey": prefix + "-20260101T000000Z.dump",
            "ranges": {"events": [1, 128], "rsvps": [8, 10]}}
    expected, key_file, bundle = (scratch / name for name in ("plan", "key", "bundle"))
    plan_bytes = snapshot["packed"](plan)
    expected.write_bytes(plan_bytes)
    key_file.write_bytes(secrets.token_bytes(32))
    plan, key = snapshot["load_plan"](expected, key_file)
    url = f"postgres://agent_test:{password}@127.0.0.1:5432/{source}?sslmode=disable"
    with_path = os.environ["PATH"]
    os.environ["PATH"] = db.env["PATH"]
    try:
        snapshot["capture"](plan, key, url, bundle)
    finally:
        os.environ["PATH"] = with_path
    archive, sidecar, baseline = (bundle / name for name in ("archive.dump", "archive.digest.json", "baseline.json"))
    inputs = (expected, archive, sidecar, baseline)

    def read(path):
        return snapshot["private_read"](path, 1 << 20 if path == archive else 4096)

    # Freeze the producer's pins outside the restore input directory.
    pins = (hashlib.sha256(plan_bytes).digest(),
            *(hashlib.sha256(read(path)).digest() for path in inputs[1:]))

    def admit_bundle():
        if tuple(hashlib.sha256(read(path)).digest() for path in inputs) != pins:
            raise Refused("bundle pin mismatch")
        verify_receipt(archive, plan["archiveKey"], sidecar)

    for path in inputs:
        original = read(path)
        path.write_bytes(original + b" ")
        expect_refusal(admit_bundle)
        path.write_bytes(original)
    verdict("archive, receipts and plan pin controls PASS")

    wrong = db.create("wrong")
    expect_refusal(lambda: target_env(db, target, wrong))
    db.sql(target, "CREATE VIEW public.rehearsal_nonempty AS SELECT 1")
    expect_refusal(lambda: target_env(db, target, target))
    db.sql(target, "DROP VIEW public.rehearsal_nonempty")
    verdict("wrong and nonempty target controls PASS")

    def restore(env):
        admit_bundle()
        with archive.open("rb") as data:
            return subprocess.run(["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner",
                                   "--no-privileges", "--dbname=" + env["PGDATABASE"]],
                                  env=env, stdin=data, capture_output=True, timeout=30)

    env = target_env(db, target, target)
    require(restore(env).returncode == 0)
    compare = snapshot["compare"]
    require(compare(plan, key, archive, baseline, env) == "MATCH")
    verdict("restore and private comparison PASS")
    db.sql(target, "UPDATE public.events SET sync_revision = sync_revision - 1")
    require(compare(plan, key, archive, baseline, env) == "MISMATCH")
    verdict("same-count comparison control PASS")
    if mode == "cancellation":
        verdict("populated cancellation checkpoint PASS")
        time.sleep(120)
        raise ProofError("cancellation was not delivered")
    db.cleanup()
    require(all(db.identity(name) is None for name in (source, target, wrong)))
    verdict("database identity teardown PASS")
    failed_target = db.create("failure")
    env = target_env(db, failed_target, failed_target)
    failed = restore({**env, "PGOPTIONS": "-c default_transaction_read_only=on"})
    require(failed.returncode != 0 and b"read-only transaction" in failed.stderr)
    require(target_env(db, failed_target, failed_target) == env)
    raise ExpectedRestoreFailure


def main():
    os.umask(0o077)

    def interrupt(_signal, _frame):
        raise KeyboardInterrupt

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    try:
        mode, = sys.argv[1:]
        require(mode in {"audit", "proof", "cancellation"})
        job = Job()
        if mode == "audit":
            residue = job.scratch.exists() or bool(job.resources())
            job.clean()
            require(not residue)
            verdict("independent teardown audit PASS")
        else:
            try:
                with job.service() as (db, password):
                    proof(db, password, job.scratch, mode)
            except ExpectedRestoreFailure:
                require(mode == "proof")
                verdict("real restore error, empty rollback and teardown PASS")
            else:
                raise ProofError("restore failure control did not execute")
            verdict("synthetic rehearsal PASS")
    except KeyboardInterrupt:
        verdict("synthetic rehearsal CANCELLED")
        return 1
    except Exception:
        verdict("synthetic rehearsal FAIL")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
