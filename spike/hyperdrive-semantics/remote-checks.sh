#!/usr/bin/env bash
# Staging acceptance only: ephemeral edge preview, not wrangler deploy/local control.
set -euo pipefail
scratch="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-}}"
[[ -n "$scratch" && -d "$scratch" ]] || { printf '%s\n' 'Paperclip run scratch required' >&2; exit 2; }
# The supervisor is outside the runner's session. Never wrap it in GNU timeout:
# killing the owner would prevent it from killing/reaping orphaned preview children.
exec python3 - "$PWD" "$scratch" <<'PY'
import ctypes
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

STOP = False


def interrupted(signum, frame):
    global STOP
    STOP = True


def enable_subreaper():
    # Linux PR_SET_CHILD_SUBREAPER: orphaned grandchildren become our children,
    # not init's. This owner survives the runner's SIGKILL and waitpid()s them.
    if sys.platform != "linux" or ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("remote_linux_subreaper_required")


def kill_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def reap_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False


def run_bounded(command, cwd, env, timeout_s, grace_s=10, output=None):
    # Wrangler must inherit this group (no detached:true in the Node runner).
    child = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=output, stderr=output)
    deadline = time.monotonic() + timeout_s
    try:
        while child.poll() is None and not STOP and time.monotonic() < deadline:
            time.sleep(0.05)
        status = child.returncode if child.returncode is not None else (130 if STOP else 124)
    finally:
        # Teardown runs for timeout, abrupt runner exit, build failure, and signals.
        # It is not contingent on the killed Node runner's finally block.
        kill_group(child.pid, signal.SIGTERM)
        grace = time.monotonic() + grace_s
        while time.monotonic() < grace:
            if child.poll() is not None and reap_children():
                break
            time.sleep(0.05)
        kill_group(child.pid, signal.SIGKILL)
        child.wait(timeout=2)
        reap_deadline = time.monotonic() + 2
        while not reap_children():
            if time.monotonic() >= reap_deadline:
                raise RuntimeError("remote_descendants_not_reaped")
            time.sleep(0.02)
    return status if status >= 0 else 128 - status


def git(repo, *args):
    # Do not print Git's paths/errors (or allow ambient Git config to run helpers).
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(repo),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
    result = subprocess.run(["git", "-C", str(repo), *args], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if result.returncode:
        raise RuntimeError("remote_source_snapshot_failed")
    return result.stdout


def require_clean(repo, revision=None):
    if git(repo, "status", "--porcelain=v1", "--untracked-files=all"):
        raise RuntimeError("remote_source_tree_not_clean")
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    if not re.fullmatch(r"[a-f0-9]{40,64}", head):
        raise RuntimeError("remote_source_revision_invalid")
    if revision is not None and head != revision:
        raise RuntimeError("remote_source_revision_changed")
    return head


def snapshot_source(repo, run_dir):
    revision = require_clean(repo)
    # Git objects, not working files, are the only source input. Even an edit
    # after the final clean check cannot change either bundle's archived inputs.
    archive = git(repo, "archive", "--format=tar", revision)
    source = run_dir / "source"
    source.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tree:
        for entry in tree.getmembers():
            # The fixed harness needs only regular files/directories. Refuse
            # links/special files rather than let an import escape the snapshot.
            if (not entry.isfile() and not entry.isdir()) or Path(entry.name).is_absolute() or ".." in Path(entry.name).parts:
                raise RuntimeError("remote_source_snapshot_unsafe")
        tree.extractall(source)
    require_clean(repo, revision)
    (source / ".w1-source-revision").write_text(revision + "\n")
    # Installed dependencies remain lockfile-pinned; no install/network is done.
    lock = json.loads((source / "package-lock.json").read_text())
    for package in ("esbuild", "wrangler", "postgres"):
        installed = json.loads((repo / "node_modules" / package / "package.json").read_text())
        if installed["version"] != lock["packages"]["node_modules/" + package]["version"]:
            raise RuntimeError("remote_installed_dependency_mismatch")
    (source / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    for directory, dirs, files in os.walk(source):
        for name in files:
            os.chmod(Path(directory) / name, 0o400)
        for name in dirs:
            target = Path(directory) / name
            if not target.is_symlink():
                os.chmod(target, 0o500)
    source.chmod(0o500)
    return source, revision


def final_result_exists(run_dir, revision):
    # Node atomically publishes only a validated/allowlisted response. Still
    # reject absent, truncated, wrong-revision or unsupported final envelopes.
    try:
        evidence = json.loads((run_dir / "result.json").read_text())
        if not isinstance(evidence, dict) or set(evidence) != {"revision", "wranglerVersion", "runtime", "receipt", "result"}:
            return False
        result = evidence["result"]
        if (evidence["revision"] != revision or evidence["runtime"] != "ephemeral-remote-preview-not-deployed-worker"
                or not isinstance(evidence["receipt"], dict) or not isinstance(result, dict)
                or type(result.get("ok")) is not bool
                or not (type(result.get("cleanup")) is bool or result.get("cleanup") == "not_verified")
                or "cleanup" not in result):
            return False
        allowed = {"ok", "cleanup", "created", "schema", "error", "checks", "passed", "total", "version", "failedStage", "teardownFailures", "path"}
        if set(result) - allowed or ("schema" in result and not re.fullmatch(r"w1_staging_[a-f0-9]{32}", str(result["schema"]))):
            return False
        if "error" in result and not re.fullmatch(r"remote_[a-z_]+|cloudflare_read_denied_http_\d+_code_[\w]+", str(result["error"])):
            return False
        if result["ok"]:
            return (result.get("cleanup") is True and result.get("created") is True
                    and result.get("passed") == 3 and result.get("total") == 3
                    and isinstance(result.get("checks"), list) and len(result["checks"]) == 3
                    and all(isinstance(check, dict) and check.get("pass") is True for check in result["checks"]))
        return "error" in result or "failedStage" in result or isinstance(result.get("checks"), list)
    except (OSError, ValueError, TypeError):
        return False


def persist_runner_failure(run_dir, source, revision, status):
    if final_result_exists(run_dir, revision):
        return False  # Preserve already complete check/cleanup evidence verbatim.
    result = {"ok": False, "error": "remote_runner_failed", "cleanup": "not_verified"}
    try:
        text = (run_dir / "private-wrangler.log").read_text(errors="replace")
        for marker in reversed(re.findall(r"W1_SCHEMA (\{[^\n]+\})", text)):
            try:
                state = json.loads(marker)
                schema = state.get("schema") if isinstance(state, dict) else None
                if isinstance(schema, str) and re.fullmatch(r"w1_staging_[a-f0-9]{32}", schema):
                    result["schema"] = schema
                    break
            except ValueError:
                pass
    except OSError:
        pass
    evidence = {"revision": revision, "runtime": "ephemeral-remote-preview-not-deployed-worker",
                "runnerExitStatus": status, "result": result}
    try:
        version = json.loads((source / "node_modules/wrangler/package.json").read_text())["version"]
        if isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version):
            evidence["wranglerVersion"] = version
    except (OSError, ValueError, KeyError, TypeError):
        pass
    pending = run_dir / "supervisor-result.pending.json"
    pending.write_text(json.dumps(evidence, indent=2))
    pending.chmod(0o600)
    os.replace(pending, run_dir / "result.json")
    print(json.dumps(evidence, indent=2))
    return True


def main(repo, scratch):
    os.umask(0o077)
    enable_subreaper()  # Refuse unsupported teardown before any provider access.
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    deadline = time.monotonic() + 600
    run_dir = Path(tempfile.mkdtemp(prefix="w1-remote-", dir=scratch))
    source, revision = snapshot_source(repo, run_dir)
    runner = run_dir / "remote-runner.mjs"
    build_env = {"PATH": os.environ.get("PATH", ""), "HOME": str(run_dir), "TMPDIR": str(run_dir)}
    with (run_dir / "private-build.log").open("w") as log:
        status = run_bounded([str(repo / "node_modules/.bin/esbuild"),
                              str(source / "spike/hyperdrive-semantics/remote-runner.ts"),
                              "--bundle", "--platform=node", "--format=esm", "--outfile=" + str(runner)],
                             source, build_env, min(30, max(0, deadline - time.monotonic())), output=log)
    if status or STOP:
        raise RuntimeError("remote_runner_build_failed")
    # Internal provenance/scratch fields come from this supervisor, not callers.
    env = {**build_env, "CLOUDFLARE_API_TOKEN": os.environ.get("CLOUDFLARE_API_TOKEN", ""),
           "PAPERCLIP_AGENT_ID": os.environ.get("PAPERCLIP_AGENT_ID", ""),
           "W1_REMOTE_RUN_DIR": str(run_dir), "W1_SOURCE_REVISION": revision}
    status = 1
    try:
        status = run_bounded(["node", str(runner), "--run"], source, env,
                             max(0, deadline - time.monotonic()))
    finally:
        # After reaping, the surviving owner preserves exact-schema uncertainty
        # even when Node's finally/result write never ran. Process death is not DROP.
        missing = persist_runner_failure(run_dir, source, revision, status)
    return status or (1 if missing else 0)


if __name__ == "__main__":
    try:
        status = main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except Exception as error:
        # Never expose arbitrary tool output, filesystem paths or credentials.
        message = str(error)
        print(message if re.fullmatch(r"remote_[a-z_]+", message) else
              "remote_supervisor_failed; no success or cleanup claimed", file=sys.stderr)
        status = 1
    sys.exit(status)
PY
