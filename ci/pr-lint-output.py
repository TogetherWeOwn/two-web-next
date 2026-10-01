#!/usr/bin/env python3
"""Round-trip PR metadata through a job-owned JSON file."""

import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("resolve", "check"))
    args = parser.parse_args()
    if args.command == "resolve":
        resolve()
    else:
        check()
