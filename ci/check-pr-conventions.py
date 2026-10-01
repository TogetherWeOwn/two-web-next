#!/usr/bin/env python3
"""Conventional-commit PR/conventions check (TOG-9865).

Shared by the pull_request/push path and the workflow_dispatch path in
.github/workflows/pr-lint.yml. Reads its inputs from the environment so both
jobs stay in lockstep:

  EVENT   github.event_name (pull_request | push | workflow_dispatch)
  TITLE   PR title (pull_request / workflow_dispatch only)
  BODY    PR body (pull_request / workflow_dispatch only)
  AUTHOR  PR author login (pull_request / workflow_dispatch only)
  COMMITS JSON list of {id, message} (push only)
  REQUIRE_CARD_REF "true" to require a Refs: TOG-1234 card reference.
"""

import json
import os
import re
import sys

TYPES = "feat|fix|perf|refactor|test|docs|build|ci|chore|revert|style|security"
HEADER = re.compile(rf"^({TYPES})(\([A-Za-z0-9._/,-]+\))?!?: \S.*$")
HELP = ("Expected a Conventional Commits header, e.g. 'fix(auth): refuse expired sudo "
        "sessions' or 'feat(events): shareable event page'. Allowed types: "
        + TYPES.replace("|", ", ") + ". Put the card ID in the body as 'Refs: TOG-1234'.")


def header_errors(text):
    errs = []
    if not HEADER.match(text):
        errs.append("not a Conventional Commits header")
    if len(text) > 100:
        errs.append(f"{len(text)} chars (max 100)")
    if text.rstrip().endswith("."):
        errs.append("ends with a period")
    return errs


def strip_reference_comments(body):
    """Remove HTML comments through EOF, but not Markdown code literals."""
    tokens = re.compile(
        r"^ {0,3}(?P<fence>`{3,}[^`\n]*|~{3,}[^\n]*)(?:\n|$)|`+|<!--", re.M
    )
    parts = []
    pos = 0
    while match := tokens.search(body, pos):
        parts.append(body[pos:match.start()])
        token = match.group()
        end = match.end()
        if match.group("fence"):
            marker = re.match(r"`+|~+", match.group("fence")).group()
            closing = re.search(
                rf"^ {{0,3}}{re.escape(marker[0])}{{{len(marker)},}}[ \t]*\r?$",
                body[end:], flags=re.M,
            )
            end = end + closing.end() if closing else len(body)
        else:
            escapes = len(body[:match.start()]) - len(body[:match.start()].rstrip("\\"))
            if escapes % 2:
                parts.append(token)
                pos = end
                continue
            if token == "<!--":
                closing = body.find("-->", end)
                pos = closing + 3 if closing >= 0 else len(body)
                continue
            # Inline code closes with the same backtick run, within its paragraph.
            paragraph = re.search(r"\r?\n[ \t]*\r?\n", body[end:])
            limit = end + paragraph.start() if paragraph else len(body)
            for closing in re.finditer(r"`+", body[end:limit]):
                if closing.group() == token:
                    end += closing.end()
                    break
        parts.append(body[match.start():end])
        pos = end
    parts.append(body[pos:])
    return "".join(parts)


def check_pr(title, body, author, require_card_ref):
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
    if require_card_ref and not re.search(
        r"^[ \t]*Refs:[ \t]+TOG-\d+[ \t]*\r?$", strip_reference_comments(body), flags=re.M
    ):
        failed = True
        print("::error title=Card reference::Add 'Refs: TOG-1234' to the PR body.")
    return failed


def main():
    event = os.environ.get("EVENT", "")
    require_card_ref = os.environ.get("REQUIRE_CARD_REF", "true") == "true"
    if event == "push":
        failed = False
        for c in json.loads(os.environ.get("COMMITS") or "[]") or []:
            subject = (c.get("message") or "").splitlines()[0] if c.get("message") else ""
            if subject.startswith(("Merge ", "Revert \"")):
                continue
            errs = header_errors(subject)
            if errs:
                failed = True
                print(f"::error title=Commit on main::{c.get('id', '')[:10]} '{subject}': "
                      f"{'; '.join(errs)}. Merge PRs with squash and the PR title as the "
                      "commit title.")
    else:
        title = os.environ.get("TITLE", "").strip()
        body = os.environ.get("BODY", "") or ""
        author = os.environ.get("AUTHOR", "")
        failed = check_pr(title, body, author, require_card_ref)
    if failed:
        sys.exit(1)
    print("PR conventions OK")


if __name__ == "__main__":
    main()
