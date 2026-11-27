"""Verify Gitleaks evidence for a metadata edit without running another scan."""

import json
import os
import subprocess
import time
from pathlib import Path


def identity(pr):
    head, base = pr["head"], pr["base"]
    return (pr["number"], head["sha"], head["ref"], head["repo"]["id"],
            base["ref"], base["repo"]["id"])


def collection(api, path, key):
    result = api(path + "&per_page=100")
    rows = result[key]
    if len(rows) != result["total_count"] or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Incomplete Actions evidence")
    return rows


def source_scan(api, pr, current_run):
    head = pr["head"]
    runs = collection(api, f"actions/workflows/pr-gates.yml/runs?head_sha={head['sha']}", "workflow_runs")
    for run in sorted(runs, key=lambda row: row["run_number"], reverse=True):
        run_id = run["id"]
        if (run_id == current_run or run["path"] != ".github/workflows/pr-gates.yml"
                or run["event"] != "pull_request" or run["head_sha"] != head["sha"]
                or run["head_branch"] != head["ref"]
                or (run["head_repository"] or {}).get("id") != head["repo"]["id"]):
            continue
        associations = run["pull_requests"]
        if len(associations) != 1:
            raise ValueError("Ambiguous Actions run association")
        if associations[0]["number"] != pr["number"]:
            continue
        if identity(associations[0]) != identity(pr):
            return None

        jobs = collection(api, f"actions/runs/{run_id}/jobs?filter=all", "jobs")
        for job in jobs:
            if ((job["head_sha"], job["run_id"]) != (head["sha"], run_id)
                    or not 1 <= job["run_attempt"] <= run["run_attempt"]):
                raise ValueError("Actions job identity mismatch")
        if any(job["name"] in ("pr-lint", "gitleaks") and job.get("labels") == ["ubuntu-24.04"]
               for job in jobs):
            continue

        # The newest run without positive metadata evidence owns the verdict.
        if run["status"] != "completed":
            return None
        scans = [job for job in jobs if job["name"] == "gitleaks"]
        if run["conclusion"] == "cancelled" or not scans:
            raise ValueError("The latest source run did not finish Gitleaks")
        attempt = max(job["run_attempt"] for job in scans)
        latest = [job for job in scans if job["run_attempt"] == attempt]
        if len(latest) != 1:
            raise ValueError("Ambiguous source scan attempt")
        scan = latest[0]
        if (scan["status"] != "completed" or scan["conclusion"] != "success"
                or not any(step["name"] == "Scan the full history" and step["conclusion"] == "success"
                           for step in scan["steps"])):
            raise ValueError(f"The latest source scan did not pass: {scan['html_url']}")
        return scan["id"], scan["html_url"]
    return None


def main():
    pr = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["pull_request"]
    repo = os.environ["GITHUB_REPOSITORY"]
    run_id = int(os.environ["GITHUB_RUN_ID"])

    def api(path):
        return json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/{path}"], timeout=15))

    def verify_current():
        live = api(f"pulls/{pr['number']}")
        if live["state"] != "open" or identity(live) != identity(pr):
            raise ValueError("The pull request head or target changed")

    deadline = time.monotonic() + 360
    while time.monotonic() < deadline:
        verify_current()
        proof = source_scan(api, pr, run_id)
        if proof and proof == source_scan(api, pr, run_id):
            verify_current()
            print(f"Verified source scan on {pr['head']['sha']}: {proof[1]}")
            return
        time.sleep(15)
    raise ValueError("Timed out waiting for the latest source scan")


if __name__ == "__main__":
    main()
