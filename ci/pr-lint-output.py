#!/usr/bin/env python3
"""Round-trip PR metadata through a job-owned JSON file.

The check step first runs ci/check-pr-conventions.py (Conventional Commits
title, non-empty body, no internal IDs: always errors or warnings), then the
upstream body/branch/reference gate .github/scripts/pr_standards.py, but only
for pull_request events when the workflow sets PR_STANDARDS_MODE (real CI sets
"warn"; the hermetic repo tests set neither, so they keep proving the
error-level policy alone). Push and dispatched release-PR checks keep their
proven behavior in the first checker. TITLE/BODY/AUTHOR come from the bound
metadata file; HEAD_REF and REPO_PRIVATE come from the step environment, never
from shell interpolation."""

import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

from floor_waiver_body import missing_body_waivers


def check_queue_visible_waivers(body):
    base_sha = os.environ.get("FLOOR_WAIVER_BASE_SHA", "").strip()
    if not base_sha:
        print("::error::Missing immutable PR base SHA for floor-waiver validation.")
        sys.exit(2)
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", base_sha, "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        messages = subprocess.run(
            ["git", "log", "--first-parent", "--format=%B", f"{merge_base}..HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout
    except (subprocess.CalledProcessError, OSError):
        print("::error::Could not read the PR commit range for floor-waiver validation.")
        sys.exit(2)
    missing = missing_body_waivers(messages, body)
    if missing:
        print("::error::Every Floor-waiver trailer in branch commits must appear verbatim in the PR body for merge-queue validation.")
        for waiver in missing:
            print(f"  Missing from PR body: {waiver}")
        sys.exit(1)
    print("PR floor-waiver trailers are visible to merge-queue validation.")


def resolve():
    # Bind identity/revision before publishing any output, then keep the decoded
    # JSON intact through the job-owned file (including trailing LFs and CRs).
    response = subprocess.run(
        [sys.executable, str(Path(__file__).with_name("resolve-pr-metadata.py"))],
        check=True, stdout=subprocess.PIPE, text=True,
    )
    metadata = json.loads(response.stdout)
    # Keep arbitrary values out of output commands and avoid a large encoded env value.
    # https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#multiline-strings
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.environ["RUNNER_TEMP"],
                                     prefix="pr-lint-", suffix=".json", delete=False) as payload:
        json.dump(metadata, payload)
        path = payload.name
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8", newline="\n") as output:
        output.write("metadata=" + path + "\n")


def check():
    path = Path(os.environ["PR_METADATA_PATH"])
    with path.open(encoding="utf-8") as payload:
        metadata = json.load(payload)
    path.unlink()
    for key in ("event", "title", "body", "author"):
        os.environ[key.upper()] = metadata[key]
    runpy.run_path(str(Path(__file__).with_name("check-pr-conventions.py")), run_name="__main__")
    if metadata["event"] == "pull_request":
        check_queue_visible_waivers(metadata["body"])
    # Upstream body/branch/reference gate: the strict title/body subset (tracker IDs,
    # instance UI links, the internal host) always fails on a public repo; the rest
    # follows the mode. Pull requests only: push and workflow_dispatch keep the proven
    # first-checker behavior. It shares the exact TITLE/BODY/AUTHOR the binding step pinned;
    # HEAD_REF and REPO_PRIVATE arrive through the step env. Absent in the
    # hermetic harness, so repo tests keep proving the error-level policy alone.
    # A nonzero exit here must fail the step, like the checker above.
    if os.environ["EVENT"] == "pull_request" and os.environ.get(
        "PR_STANDARDS_MODE", ""
    ).strip().lower() in ("warn", "error"):
        standards = Path(__file__).resolve().parent.parent / ".github" / "scripts" / "pr_standards.py"
        env = {
            "EVENT": os.environ["EVENT"],
            "TITLE": os.environ["TITLE"],
            "BODY": os.environ["BODY"],
            "AUTHOR": os.environ["AUTHOR"],
            "HEAD_REF": os.environ.get("HEAD_REF", ""),
            "REPO_PRIVATE": os.environ.get("REPO_PRIVATE", "false"),
            "REQUIRE_CARD_REF": "false",
            "PR_STANDARDS_MODE": os.environ["PR_STANDARDS_MODE"],
            "PR_NUMBER": os.environ.get("PR_NUMBER", ""),
            "HEAD_REF_ERROR_FROM_PR": os.environ.get("HEAD_REF_ERROR_FROM_PR", ""),
        }
        completed = subprocess.run([sys.executable, str(standards)], env=env, check=False)
        if completed.returncode != 0:
            sys.exit(completed.returncode)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("resolve", "check"))
    args = parser.parse_args()
    if args.command == "resolve":
        resolve()
    else:
        check()
