import json
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCES = {
    "ci": ("ci-ok",),
    "e2e": ("e2e-ok",),
    "pr-gates": ("pr-lint", "gitleaks"),
    "pr-size": ("pr-size-gate / gate",),
    "pr-standards-required": ("pr-standards",),
}
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
    if not key:
        return [row for batch in batches for row in batch]
    total = batches[0]["total_count"]
    require(type(total) is int and 0 <= total < 1000, "GitHub metadata count missing or capped")
    rows = []
    for batch in batches:
        require(batch["total_count"] == total and len(batch[key]) == min(100, total - len(rows)),
                "Incomplete GitHub metadata page")
        rows.extend(batch[key])
    require(len(rows) == total and len({row["id"] for row in rows}) == total,
            "Incomplete or duplicate GitHub metadata")
    return rows


def select_runs(api, pr, ready):
    head, base = pr["head"], pr["base"]
    runs = pages(api, f'/actions/runs?head_sha={head["sha"]}', "workflow_runs")
    latest = {}
    for source in SOURCES:
        matches = [run for run in runs if run["path"] == f".github/workflows/{source}.yml"
                   and (run["event"] == "pull_request" or
                        (source == "pr-size" and run["event"] == "pull_request_review"))
                   and run["head_sha"] == head["sha"] and run["head_branch"] == head["ref"]
                   and (run["head_repository"] or {}).get("id") == head["repo"]["id"]
                   and any(assoc["number"] == pr["number"] and assoc["base"]["ref"] == base["ref"]
                           and assoc["base"]["repo"]["id"] == base["repo"]["id"]
                           for assoc in run["pull_requests"])]
        if matches:
            require(all(positive(run[k]) for run in matches for k in ("id", "run_number", "run_attempt")),
                    "Invalid Actions run identity")
            run = max(matches, key=lambda item: (item["run_number"], item["id"]))
            # Draft CI and E2E can fast-pass while their heavy jobs are skipped.
            outcome = "superseded" if source in ("ci", "e2e") and run["created_at"] < ready else result(run)
            latest[source] = (run["id"], run["run_attempt"], outcome)
    return latest


def collect(api, pr, web):
    timeline = pages(api, f'/issues/{pr["number"]}/timeline')
    ready = max((entry["created_at"] for entry in timeline if entry["event"] == "ready_for_review"), default="")
    selected = select_runs(api, pr, ready)
    rows = ["| Gate | Run attempt | Job | Evidence |", "| --- | --- | --- | --- |"]
    for source, names in SOURCES.items():
        run_id, attempt, outcome = selected.get(source, (None, None, "missing"))
        run_path = f"/actions/runs/{run_id}"
        attempt_path = f"{run_path}/attempts/{attempt}"
        run_link = f"[{outcome}]({web}{attempt_path})" if run_id else outcome
        jobs = pages(api, f"{attempt_path}/jobs", "jobs") if outcome in CONCLUSIONS else []
        require(all(positive(job["id"]) and job["head_sha"] == pr["head"]["sha"]
                    and job["run_id"] == run_id and job["run_attempt"] == attempt for job in jobs),
                "Job differs from selected head or attempt")
        for name in names:
            matching = [job for job in jobs if job["name"] == name]
            job = matching[0] if len(matching) == 1 else None
            status = result(job) if job else "ambiguous" if matching else "missing"
            job_link = f'[{status}]({web}{run_path}/job/{job["id"]})' if job else status
            evidence = outcome if outcome != "success" else status
            if evidence == "success" and pr["draft"]:
                evidence = "draft"
            rows.append(f"| {name} | {run_link} | {job_link} | {evidence} |")
    require(selected == select_runs(api, pr, ready), "Actions runs changed during collection")
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
             and all(comment["user"].get(k) == v for k, v in BOT.items())]
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
    draft = "Draft PR. Aggregators may fast-pass.\n\n" if pr["draft"] else ""
    footer = f"See the [PR checks]({link}/checks) for live status. Copy this comment’s link to Verification.\n"
    try:
        summary = f"{heading}\n{draft}{collect(api, pr, web)}\n\n{footer}"
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
        data = subprocess.run(args, input=json.dumps(body), text=True, capture_output=True, timeout=20)
        require(data.returncode == 0, "GitHub metadata request failed")
        return json.loads(data.stdout)

    return request


if __name__ == "__main__":
    try:
        repo = os.environ["GITHUB_REPOSITORY"]
        api = github_api(repo)
        if os.getenv("PR_NUMBER"):
            number = int(os.environ["PR_NUMBER"])
            require(positive(number), "Invalid PR number")
            publish(api, repo, number)
        else:
            numbers = route(api, json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))
            Path(os.environ["GITHUB_OUTPUT"]).write_text(f"numbers={json.dumps(numbers)}\n")
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        sys.exit("PR evidence publication failed. Check the exact-head Actions and PR metadata.")
