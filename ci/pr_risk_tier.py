#!/usr/bin/env python3
"""Enforce the author-declared minimum risk tier from the PR template."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path


TIERS = ("T0", "T1", "T2")
CRITICAL_DIRS = frozenset("migrations sql db database drizzle".split())
CRITICAL_WORDS = frozenset("""
    auth authn authz authentication authorization oauth session sessions billing payment payments
    permission permissions gateway voice crypto vault secret secrets backup backups dump dumps
    grant grants role roles erasure ingest
""".split())
TEXT_DOCS = frozenset("""
    readme.txt license.txt notice.txt changelog.txt contributing.txt code_of_conduct.txt
    security.txt support.txt authors.txt
""".split())
DOC_SUFFIXES = (".md", ".rst")
WORD_BOUNDARY = re.compile(r"[\W_]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
WRANGLER = re.compile(r"wrangler(?:[.-].*)?\.(?:toml|jsonc?)", re.IGNORECASE | re.DOTALL)
HIDDEN = re.compile(
    r"<!--.*?(?:-->|\Z)"
    r"|^ {0,3}(?P<ticks>`{3,})[^`\n]*(?:\n|\Z).*?(?:^ {0,3}(?P=ticks)`*[ \t]*$|\Z)"
    r"|^ {0,3}(?P<tildes>~{3,})[^\n]*(?:\n|\Z).*?(?:^ {0,3}(?P=tildes)~*[ \t]*$|\Z)",
    re.DOTALL | re.MULTILINE,
)
HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$")


def path_tier(path):
    """Return the highest applicable floor as an index into TIERS."""
    *directories, name = path.split("/")
    basename = name.lower()
    prose = basename.endswith((*DOC_SUFFIXES, ".txt"))
    modules = directories if prose else [*directories, name]
    if (
        any(directory.lower() in CRITICAL_DIRS for directory in directories)
        or any(word.lower() in CRITICAL_WORDS
               for module in modules for word in WORD_BOUNDARY.split(module))
        or path.startswith((".github/", "crates/cutover/"))
        or WRANGLER.fullmatch(name)
    ):
        return 0
    if path.startswith("ci/"):
        return 1
    if basename in TEXT_DOCS or (basename.endswith(DOC_SUFFIXES) and
                                 (not directories or directories[0] == "docs")):
        return 2
    return 1


def declared_tier(body):
    """Read the template field in the visible Attestation preamble."""
    fields = []
    sections = 0
    preamble = False
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    visible = HIDDEN.sub(lambda match: " " + "\n" * match[0].count("\n"), body)
    for line in visible.split("\n"):
        if heading := HEADING.fullmatch(line):
            preamble = heading.groups() == ("##", "Attestation")
            sections += preamble
        elif preamble and line.startswith("risk_tier:"):
            fields.append(line.removeprefix("risk_tier:").strip(" \t"))
    if sections != 1 or len(fields) != 1 or fields[0] not in TIERS:
        raise ValueError("Add exactly one visible `risk_tier: T0`, `risk_tier: T1`, or "
                         "`risk_tier: T2` line under `## Attestation` before its subsections.")
    return fields[0]


def changed_paths(base):
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("Missing or invalid PR base SHA for risk-tier validation.")
    # Disabling rename detection exposes each side as its own changed path.
    # Git compares immutable trees and returns every path without API file caps.
    output = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z", f"{base}...HEAD", "--"],
        check=True, capture_output=True,
    ).stdout
    return [os.fsdecode(path) for path in output.split(b"\0") if path]


def validate(body, paths):
    declared = declared_tier(body)
    minimum = TIERS[min(map(path_tier, paths), default=2)]
    if TIERS.index(declared) > TIERS.index(minimum):
        raise ValueError(f"Declared risk tier {declared} is below the changed-path minimum {minimum}. "
                         "Update `risk_tier` in the PR Attestation.")
    return f"Declared risk tier {declared} meets the changed-path minimum {minimum}."


def main():
    try:
        metadata = json.loads(Path(os.environ["PR_METADATA_PATH"]).read_text(encoding="utf-8"))
        print(validate(metadata["body"], changed_paths(os.environ.get("FLOOR_WAIVER_BASE_SHA", ""))))
    except (subprocess.CalledProcessError, OSError, KeyError):
        print("::error::Could not read bound PR metadata or the exact changed paths.")
        return 1
    except ValueError as error:
        print(f"::error title=PR risk tier::{error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
