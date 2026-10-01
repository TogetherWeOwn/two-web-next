#!/usr/bin/env python3
"""Round-trip PR metadata through a job-owned JSON file."""

import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile


def resolve():
    event = os.environ["EVENT"]
    if event == "workflow_dispatch":
        number = os.environ["PR_NUMBER"]
        print(f"Validating release PR #{number} via the API.")
        # Decode the API response directly: shell command substitution strips trailing LFs.
        response = subprocess.run(
            ["gh", "pr", "view", number, "--repo", os.environ["GITHUB_REPOSITORY"],
             "--json", "title,body,author"],
            check=True, capture_output=True, text=True,
        )
        pr = json.loads(response.stdout)
        title, body, author = pr["title"], pr["body"], pr["author"]["login"]
        event = "pull_request"
    else:
        title = os.environ.get("EVENT_TITLE", "")
        body = os.environ.get("EVENT_BODY", "")
        author = os.environ.get("EVENT_AUTHOR", "")
    metadata = {"event": event, "title": title, "body": body, "author": author}
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("resolve", "check"))
    args = parser.parse_args()
    if args.command == "resolve":
        resolve()
    else:
        check()
