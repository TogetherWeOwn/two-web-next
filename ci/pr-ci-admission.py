"""Wait for the current PR's required prerequisite jobs, from GitHub Actions."""

import json
import os
import subprocess
import time
from pathlib import Path

GATES = {"pr-gates": {"pr-lint", "gitleaks"}, "pr-size": {"pr-size-gate / gate"}}
IGNORED = {
    "pr-lint": "pr-gates ignored edit (lint)",
    "gitleaks": "pr-gates ignored edit (scan)",
}


def identity(pr):
    return (pr["number"], *(
        (ref["sha"], ref["ref"], ref["repo"]["id"]) for ref in (pr["head"], pr["base"])
    ))


def collection(api, path, key):
    result = api(path + ("&" if "?" in path else "?") + "per_page=100")
    rows = result[key]
    if len(rows) != result["total_count"] or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Incomplete Actions evidence")
    return rows


def evidence(api, pr):
    head = pr["head"]
    runs = collection(api, f"actions/runs?head_sha={head['sha']}", "workflow_runs")
    proof = {}
    for workflow, names in GATES.items():
        events = {"pull_request", "pull_request_review"} if workflow == "pr-size" else {"pull_request"}
        pending = names.copy()
        for run in sorted(runs, key=lambda row: row["run_number"], reverse=True):
            if (run["path"] != f".github/workflows/{workflow}.yml" or run["event"] not in events
                    or run["head_sha"] != head["sha"] or run["head_branch"] != head["ref"]
                    or (run["head_repository"] or {}).get("id") != head["repo"]["id"]):
                continue
            associations = run["pull_requests"]
            if len(associations) != 1:
                return None
            if associations[0]["number"] != pr["number"]:
                continue
            if identity(associations[0]) != identity(pr):
                return None
            run_id, attempt = run["id"], run["run_attempt"]
            jobs = collection(api, f"actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs")
            for name in tuple(pending):
                named = [job for job in jobs if job["name"] in (name, IGNORED.get(name))]
                if len(named) != 1:
                    return None
                job = named[0]
                if (job["head_sha"], job["run_id"], job["run_attempt"]) != (head["sha"], run_id, attempt):
                    raise ValueError("Actions job identity mismatch")
                if (job["name"] == IGNORED.get(name) and job["status"] == "completed"
                        and job["conclusion"] == "skipped"):
                    continue
                if job["status"] != "completed" or job["conclusion"] == "cancelled":
                    return None
                if job["conclusion"] != "success":
                    raise ValueError(f"{name} concluded {job['conclusion']}: {job['html_url']}")
                proof[name] = (run_id, attempt, job["id"])
                pending.remove(name)
            if not pending:
                break
    return proof if set(proof) == set().union(*GATES.values()) else None


def main():
    pr = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["pull_request"]
    repository = os.environ["GITHUB_REPOSITORY"]

    def api(path):
        return json.loads(subprocess.check_output(["gh", "api", f"repos/{repository}/{path}"], timeout=15))

    def verify_current():
        live = api(f"pulls/{pr['number']}")
        if identity(live) != identity(pr) or live["state"] != "open" or live["draft"]:
            raise ValueError("Pull request head, base, or readiness changed")

    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        verify_current()
        proof = evidence(api, pr)
        if proof and proof == evidence(api, pr):
            verify_current()
            for name, (run, attempt, job) in sorted(proof.items()):
                print(f"{name} passed on {pr['head']['sha']} (attempt {attempt}): "
                      f"https://github.com/{repository}/actions/runs/{run}/job/{job}")
            return
        time.sleep(45)
    raise ValueError("Timed out waiting for current lint, scan and size evidence")


if __name__ == "__main__":
    main()
