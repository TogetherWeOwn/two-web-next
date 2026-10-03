#!/usr/bin/env python3
"""Failure-artifact sweep for e2e-staging (TOG-13046, CISO condition C2 on
TOG-13035). The repo is public, so an uploaded artifact is readable by any
signed-in GitHub user for its retention and log masking does not cover it.

Deletes every file under the given directories that contains the staging QA
token, prints file names only, and exits 1 when it removed anything so the
leak is loud instead of silent.

Usage: QA_AUTH_TOKEN=<token> ci/scrub-qa-token.py <dir>...

Exit 0: nothing found. Exit 1: found and removed (the tree is now safe to
upload). Exit 2: a file could not be removed, so the tree is NOT safe. When the
whole tree was swept (exit 0 or 1) and GITHUB_OUTPUT is set, `swept=true` is
written to it; the workflow uploads only then, so a crashed sweep never
publishes an unswept tree.

The token is read from the environment, never argv, so it is not visible in the
process list. A plain byte search is not enough on its own. Playwright stores
the places the token would land inside compressed data:
  * `playwright-report/index.html` ends with a base64 deflate zip that holds the
    test error text (`<template id="playwrightReportBase64">`);
  * traces (`trace.zip`, and the copies under `playwright-report/data/`) hold the
    request headers in `trace.trace` and `trace.network`.
So every file is searched raw, as a zip, and for an embedded base64 zip, and the
whole file is deleted on a hit.
"""

import base64
import binascii
import io
import os
import re
import sys
import zipfile

# Playwright's html reporter appends its data zip as a base64 data URL.
EMBEDDED_ZIP = re.compile(rb"data:application/zip;base64,([A-Za-z0-9+/=\s]+)")
# Archives inside archives are read this deep, so a hostile nesting cannot loop.
MAX_DEPTH = 4


def zip_hit(data: bytes, token: bytes, depth: int) -> str | None:
    """Name of the first zip member that holds the token, else None."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        for info in archive.infolist():
            if info.is_dir():
                continue
            member = archive.read(info)
            if token in member:
                return info.filename
            if depth < MAX_DEPTH and member.startswith(b"PK\x03\x04"):
                inner = zip_hit(member, token, depth + 1)
                if inner:
                    return f"{info.filename}!{inner}"
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, EOFError, OSError):
        # A corrupt archive cannot be opened by a viewer either, and the raw
        # search already covered any bytes stored uncompressed.
        return None
    return None


def file_hit(path: str, token: bytes) -> str | None:
    """Where in the file the token sits ("file", "archive member", ...) or None."""
    with open(path, "rb") as handle:
        data = handle.read()
    if token in data:
        return "file"
    if data.startswith(b"PK\x03\x04"):
        member = zip_hit(data, token, 0)
        if member:
            return f"archive member {member}"
    for match in EMBEDDED_ZIP.finditer(data):
        try:
            blob = base64.b64decode(re.sub(rb"\s", b"", match.group(1)))
        except binascii.Error:
            continue
        member = zip_hit(blob, token, 0)
        if member:
            return f"embedded archive member {member}"
    return None


def main(directories: list[str]) -> int:
    token = os.environ.get("QA_AUTH_TOKEN", "").encode()
    if not token:
        # An empty pattern matches every file; with no token there is nothing to leak.
        print("scrub-qa-token: QA_AUTH_TOKEN is empty, nothing to sweep for", file=sys.stderr)
        mark_swept()
        return 0

    removed = 0
    stuck = 0
    for directory in directories:
        if not os.path.isdir(directory):
            continue
        for root, _dirs, names in os.walk(directory):
            for name in sorted(names):
                path = os.path.join(root, name)
                if os.path.islink(path):
                    # Never follow a link out of the artifact tree; the upload does not.
                    continue
                try:
                    where = file_hit(path, token)
                except OSError:
                    # Unreadable is not clean: delete it rather than upload it.
                    where = "unreadable file"
                if where is None:
                    continue
                try:
                    os.remove(path)
                except OSError:
                    print(f"scrub-qa-token: could NOT remove {path} ({where})", file=sys.stderr)
                    stuck += 1
                    continue
                print(f"scrub-qa-token: removed {path} ({where})", file=sys.stderr)
                removed += 1

    if stuck:
        print(
            f"::error::QA_AUTH_TOKEN is in {stuck} failure artifact file(s) that could not be "
            "removed; the artifacts must not be uploaded. Treat the token as exposed."
        )
        return 2
    mark_swept()
    if removed:
        print(
            f"::error::QA_AUTH_TOKEN was found in {removed} failure artifact file(s); removed. "
            "Treat the token as exposed and report it to the COO."
        )
        return 1
    return 0


def mark_swept() -> None:
    """Tell the workflow the whole tree was swept, so the upload is safe."""
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write("swept=true\n")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:  # a crash must not look like a swept tree
        print(f"::error::scrub-qa-token crashed ({type(error).__name__}); do not upload artifacts")
        sys.exit(2)
