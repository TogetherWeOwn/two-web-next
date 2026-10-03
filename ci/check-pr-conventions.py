#!/usr/bin/env python3
"""Conventional-commit PR/conventions check.

Shared by the pull_request/push path and the workflow_dispatch path in
.github/workflows/pr-gates.yml (pr-lint job). Reads its inputs from the environment so both
jobs stay in lockstep:

  EVENT   github.event_name (pull_request | push | workflow_dispatch)
  TITLE   PR title (pull_request / workflow_dispatch only)
  BODY    PR body (pull_request / workflow_dispatch only)
  AUTHOR  PR author login (pull_request / workflow_dispatch only)
  COMMITS JSON list of {id, message} (push only)
  COMMIT_SUBJECTS_PATH optional file of PR commit subjects, one per line
                       (pull_request / workflow_dispatch only)
  INTERNAL_ID_LEVEL "warning" (default) or "error": how to report an internal card ID
                    (TOG-1234, PAP-1234) found in a title, body or commit subject.

The repository is public: internal card IDs must not appear in PR text. Board linkage lives
outside GitHub.
"""

import json
import os
import re
import sys

TYPES = "feat|fix|perf|refactor|test|docs|build|ci|chore|revert|style|security"
HEADER = re.compile(rf"^({TYPES})(\([A-Za-z0-9._/,-]+\))?!?: \S.*$")
HELP = ("Expected a Conventional Commits header, e.g. 'fix(auth): refuse expired sudo "
        "sessions' or 'feat(events): shareable event page'. Allowed types: "
        + TYPES.replace("|", ", ") + ". Keep internal card IDs out of the title.")
INTERNAL_ID = re.compile(r"\b(?:TOG|PAP)-\d+\b")


def header_errors(text):
    errs = []
    if not HEADER.match(text):
        errs.append("not a Conventional Commits header")
    if len(text) > 100:
        errs.append(f"{len(text)} chars (max 100)")
    if text.rstrip().endswith("."):
        errs.append("ends with a period")
    return errs


def internal_id_findings(title, body, subjects):
    """Name each place that carries an internal card ID. Never echoes the ID itself."""
    found = []
    if INTERNAL_ID.search(title):
        found.append("the PR title")
    # Raw body: an ID inside an HTML comment is still published text.
    if INTERNAL_ID.search(body):
        found.append("the PR body")
    found.extend(f"commit subject {n}" for n, subject in enumerate(subjects, 1)
                 if INTERNAL_ID.search(subject))
    return found


def report_internal_ids(where, level):
    """Print the finding at the configured level; return True when it must fail the check."""
    if not where:
        return False
    # Fail closed: only the exact value "warning" downgrades the finding.
    kind = "warning" if level == "warning" else "error"
    print(f"::{kind} title=Internal ID::Found an internal card ID (TOG-1234 or PAP-1234 form) in "
          f"{', '.join(where)}. This repository is public: remove it and link a public GitHub "
          "issue with 'Closes #123' or describe the problem instead.")
    return kind == "error"


def check_pr(title, body, author, subjects=(), level="warning"):
    failed = False
    if author.endswith("[bot]") and author.startswith(("dependabot", "renovate")):
        if header_errors(title):
            print(f"::warning::{author} title '{title}' is not conventional; set "
                  "commit-message.prefix (e.g. chore(deps)) in the bot config.")
        return False
    errs = header_errors(title)
    if errs:
        failed = True
        print(f"::error title=PR title::'{title}': {'; '.join(errs)}. {HELP}")
    text = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    if len(re.sub(r"\s", "", text)) < 40:
        failed = True
        print("::error title=PR body::The description is empty. Say what changed, why, "
              "and how it was tested (see the PR template).")
    if report_internal_ids(internal_id_findings(title, body, subjects), level):
        failed = True
    return failed


def read_subjects(path):
    """Commit subjects the workflow listed for the PR; missing or unreadable means none."""
    if not path:
        return []
    try:
        with open(path, encoding="utf-8") as listing:
            return [line.rstrip("\r\n") for line in listing if line.strip()]
    except OSError:
        return []


def main():
    event = os.environ.get("EVENT", "")
    level = os.environ.get("INTERNAL_ID_LEVEL", "warning").strip()
    if event == "push":
        failed = False
        subjects = []
        for c in json.loads(os.environ.get("COMMITS") or "[]") or []:
            subject = (c.get("message") or "").splitlines()[0] if c.get("message") else ""
            if subject.startswith(("Merge ", "Revert \"")):
                continue
            subjects.append(subject)
            errs = header_errors(subject)
            if errs:
                failed = True
                print(f"::error title=Commit on main::{c.get('id', '')[:10]} '{subject}': "
                      f"{'; '.join(errs)}. Merge PRs with squash and the PR title as the "
                      "commit title.")
        if report_internal_ids(internal_id_findings("", "", subjects), level):
            failed = True
    else:
        title = os.environ.get("TITLE", "").strip()
        body = os.environ.get("BODY", "") or ""
        author = os.environ.get("AUTHOR", "")
        subjects = read_subjects(os.environ.get("COMMIT_SUBJECTS_PATH", ""))
        failed = check_pr(title, body, author, subjects, level)
    if failed:
        sys.exit(1)
    print("PR conventions OK")


if __name__ == "__main__":
    main()
