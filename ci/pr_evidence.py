import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode

SOURCES = {
    "ci": ("ci-ok",),
    "e2e": ("e2e-ok",),
    "pr-gates": ("pr-lint", "gitleaks"),
    "pr-size": ("pr-size-gate / gate",),
    "pr-standards-required": ("pr-standards",),
}
READY_JOBS = {"ci": "static-check", "e2e": "browser-smoke"}
MARKER = "<!-- pr-evidence:v1 -->\n"
BOT = {"login": "github-actions[bot]", "id": 41898282}
SHA = re.compile("[0-9a-f]{40}")
CONCLUSIONS = set("action_required cancelled failure neutral skipped stale success timed_out startup_failure".split())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def positive(value):
    return type(value) is int and value > 0


def result(item):
    if item["status"] != "completed":
        return "pending"
    return item["conclusion"] if item["conclusion"] in CONCLUSIONS else "unknown"


def pages(api, path, key=None):
    path += ("&" if "?" in path else "?") + "per_page=100"
    batches = api("GET", path, paginate=True)
    require(isinstance(batches, list) and 0 < len(batches) <= 10, "GitHub metadata pagination limit reached")
    rows = [row for batch in batches for row in (batch[key] if key else batch)]
    require(len(rows) < 1000, "GitHub metadata count limit reached")
    if key:
        valid_counts = all(type(batch["total_count"]) is int and batch["total_count"] == len(rows) for batch in batches)
        require(valid_counts and len({row["id"] for row in rows}) == len(rows),
                "Incomplete or duplicate GitHub metadata")
    return rows


def select_runs(api, pr):
    head, base = pr["head"], pr["base"]
    timeline = pages(api, f'/issues/{pr["number"]}/timeline')
    ready, retarget = (max((entry["created_at"] for entry in timeline if entry["event"] == kind), default="")
                       for kind in ("ready_for_review", "base_ref_changed"))
    # GitHub's run associations can change after retargeting or closing another PR.
    branch_pulls = pages(api, "/pulls?" + urlencode({"state": "all", "head": head["label"]}))
    history = [pull for pull in branch_pulls if pull["head"]["ref"] == head["ref"]
               and (pull["head"]["repo"] or {}).get("id") == head["repo"]["id"]]
    require(any(pull["number"] == pr["number"] for pull in history), "PR branch history is incomplete")
    siblings = [(pull["created_at"], pull["closed_at"]) for pull in history if pull["number"] != pr["number"]]
    runs = pages(api, f'/actions/runs?head_sha={head["sha"]}', "workflow_runs")
    latest = {}
    for source in SOURCES:
        matches = [run for run in runs if run["path"] == f".github/workflows/{source}.yml"
                   and (run["event"] == "pull_request" or
                        (source == "pr-size" and run["event"] == "pull_request_review"))
                   and run["head_sha"] == head["sha"] and run["head_branch"] == head["ref"]
                   and (run["head_repository"] or {}).get("id") == head["repo"]["id"]
                   and (not run["pull_requests"] or any(
                       assoc["number"] == pr["number"] and assoc["base"]["ref"] == base["ref"]
                       and assoc["base"]["repo"]["id"] == base["repo"]["id"] for assoc in run["pull_requests"]))]
        if matches:
            require(all(positive(run[k]) for run in matches for k in ("id", "run_number", "run_attempt")),
                    "Invalid Actions run identity")
            run = max(matches, key=lambda item: (item["run_number"], item["id"]))
            created = run["created_at"]
            cutoff = max(pr["created_at"], retarget, ready if source in READY_JOBS else "")
            outcome = "superseded" if created < cutoff else result(run)
            outcome = "unproven" if created == retarget else outcome
            overlaps = any(opened <= created <= (closed or created) for opened, closed in siblings)
            witness = READY_JOBS.get(source) if created == ready else None
            verdict = {0: "unbound", 1: "ambiguous" if overlaps else outcome}.get(len(run["pull_requests"]), "ambiguous")
            latest[source] = (run["id"], run["run_attempt"], verdict, witness)
    return latest


def collect(api, pr, web):
    selected = select_runs(api, pr)
    rows = ["| Gate | Run attempt | Job | Evidence |", "| --- | --- | --- | --- |"]
    for source, names in SOURCES.items():
        run_id, attempt, outcome, witness = selected.get(source, (None, None, "missing", None))
        run_path = f"/actions/runs/{run_id}"
        run_link = f"[{outcome}]({web}{run_path}/attempts/{attempt})" if run_id else outcome
        jobs = pages(api, f"{run_path}/attempts/{attempt}/jobs", "jobs") if outcome in CONCLUSIONS else []
        require(all(positive(job["id"]) and job["head_sha"] == pr["head"]["sha"]
                    and job["run_id"] == run_id and job["run_attempt"] == attempt for job in jobs),
                "Job differs from selected head or attempt")
        proven = witness is None or any(job["name"] == witness and result(job) == "success" for job in jobs)
        for name in names:
            matching = [job for job in jobs if job["name"] == name]
            job = matching[0] if len(matching) == 1 else None
            status = result(job) if job else "ambiguous" if matching else "missing"
            job_link = f'[{status}]({web}{run_path}/job/{job["id"]})' if job else status
            evidence = outcome if outcome != "success" else status
            if evidence == "success" and (pr["draft"] or not proven):
                evidence = "draft" if pr["draft"] else "unproven"
            rows.append(f"| {name} | {run_link} | {job_link} | {evidence} |")
    require(selected == select_runs(api, pr), "Actions or PR history changed during collection")
    return "\n".join(rows)


def route(api, event):
    if "workflow_run" not in event:
        require(positive(event["number"]), "Invalid PR number")
        return [event["number"]]
    sha = event["workflow_run"]["head_sha"]
    require(SHA.fullmatch(sha), "Invalid workflow run head")
    # Fork workflow events can omit PR associations. Ask GitHub by exact commit.
    numbers = {pr["number"] for pr in pages(api, f"/commits/{sha}/pulls")
               if pr["state"] == "open" and pr["base"]["ref"] == "main" and pr["head"]["sha"] == sha}
    require(len(numbers) <= 256 and all(map(positive, numbers)), "Invalid PR destinations")
    return sorted(numbers)


def publish(api, repository, number):
    pull = f"/pulls/{number}"
    comments = f"/issues/{number}/comments"
    web = f"https://github.com/{repository}"

    pr = api("GET", pull)
    require(pr["number"] == number and pr["base"]["repo"]["full_name"].lower() == repository.lower(),
            "PR metadata does not match destination")
    if pr["state"] != "open" or pr["base"]["ref"] != "main":
        return
    sha = pr["head"]["sha"]
    require(SHA.fullmatch(sha) and positive(pr["head"]["repo"]["id"]), "Invalid PR head")
    owned = [comment for comment in pages(api, comments) if comment["body"].startswith(MARKER)
             and all((comment["user"] or {}).get(k) == v for k, v in BOT.items())]
    require(len(owned) <= 1 and all(positive(comment["id"]) for comment in owned), "Invalid evidence comment")
    prior = owned[0] if owned else None

    def identity(item):
        head, base = item["head"], item["base"]
        return (item["number"], item["state"], item["draft"], head["sha"], head["ref"],
                (head["repo"] or {}).get("id"), base["ref"], base["repo"]["id"])

    def write(body):
        if not prior:
            api("POST", comments, {"body": body})
        elif prior["body"] != body:
            api("PATCH", f'/issues/comments/{prior["id"]}', {"body": body})

    link = f"{web}/pull/{number}"
    heading = f"{MARKER}### PR #{number} Actions evidence\n\nHead [`{sha}`]({link}/commits/{sha}) · target `main`\n"
    footer = f"See the [PR checks]({link}/checks) for live status. Copy this comment’s link to Verification.\n"
    try:
        summary = f"{heading}\n{collect(api, pr, web)}\n\n{footer}"
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        if identity(pr) == identity(api("GET", pull)):
            write(f"{heading}\nEvidence unavailable. {footer}")
        raise
    if identity(pr) == identity(api("GET", pull)):
        write(summary)
        return summary


def github_api(repository):
    require(re.fullmatch(r"[\w.-]+/[\w.-]+", repository, re.ASCII), "Invalid repository")

    def request(method, path, body=None, *, paginate=False):
        args = ["gh", "api", "--hostname", "github.com", "--method", method, f"repos/{repository}{path}"]
        if paginate:
            args += ["--paginate", "--slurp"]
        if body is not None:
            args += ["--input", "-"]
        return json.loads(subprocess.check_output(args, input=json.dumps(body), text=True, stderr=subprocess.PIPE, timeout=20))

    return request


if __name__ == "__main__":
    try:
        repo = os.environ["GITHUB_REPOSITORY"]
        api = github_api(repo)
        if os.getenv("PR_NUMBER"):
            publish(api, repo, int(os.environ["PR_NUMBER"]))
        else:
            numbers = route(api, json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))
            Path(os.environ["GITHUB_OUTPUT"]).write_text(f"numbers={json.dumps(numbers)}\n")
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        sys.exit("PR evidence publication failed. Check the exact-head Actions and PR metadata.")
