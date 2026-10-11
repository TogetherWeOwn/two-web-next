#!/usr/bin/env python3
"""Failure-artifact sweep for e2e-staging (TOG-13046, CISO condition C2 on
TOG-13035). The repo is public, so an uploaded artifact is readable by any
signed-in GitHub user for its retention and log masking does not cover it.

Deletes every file under the given directories that contains the staging QA
token, prints file names only, and exits 1 when it removed anything so the
leak is loud instead of silent. Files that cannot be completely inspected are
withheld from the upload the same way (removed, exit 1, swept=true). A
withheld-only run means the token was not seen in what could be read, not
that it is proven absent: only a real token hit prints the exposure alarm
and needs a COO report.

Usage: QA_AUTH_TOKEN=<token> ci/scrub-qa-token.py <dir>...

Exit 0: nothing found. Exit 1: found and removed, or uninspectable files
withheld (the tree is now safe to upload). Exit 2: a file could not be
removed, so the tree is NOT safe. When the whole tree was swept (exit 0 or 1)
and GITHUB_OUTPUT is set, `swept=true` is written to it; the workflow uploads
only then, so a crashed sweep never publishes an unswept tree.

The token is read from the environment, never argv, so it is not visible in the
process list. A plain byte search is not enough on its own. Playwright stores
the places the token would land inside compressed data:
  * `playwright-report/index.html` ends with a base64 deflate zip that holds the
    test error text (`<template id="playwrightReportBase64">`);
  * traces (`trace.zip`, and the copies under `playwright-report/data/`) hold the
    request headers in `trace.trace` and `trace.network`.
So every file is searched raw, as a zip, and for an embedded base64 zip, and the
whole file is deleted on a hit.

Fail-closed inspection: an archive member that cannot be read (unsupported
compression, encrypted, corrupt, truncated) or nested content beyond the depth
cap cannot be proven clean, so the whole containing file is removed rather than
uploaded. Diagnostics never echo the token or a member name containing it.
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


class _Incomplete(Exception):
    """An archive could not be completely inspected; fail closed."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _contains_token(text: str, token: bytes) -> bool:
    """Whether a member name carries the token, without echoing either."""
    try:
        if token in text.encode("utf-8"):
            return True
    except (UnicodeError, ValueError):
        return True
    try:
        return token.decode("utf-8") in text
    except UnicodeDecodeError:
        return False


def _safe_member(filename: str, token: bytes) -> str:
    """Member name safe for diagnostics; redacted when it carries the token."""
    if _contains_token(filename, token):
        return "<redacted>"
    return filename


def _safe_path(path: str, token: bytes) -> str:
    """Outer path safe for diagnostics; redacted when it carries the token."""
    if _contains_token(path, token):
        return "<redacted>"
    return path


def _is_withheld(where: str) -> bool:
    """Whether the removal reason means incompletely inspected, not a real hit.

    Only completely inspected content that actually holds the token counts as
    a token exposure. Anything that could not be proven clean is withheld
    from the upload without claiming the token was found: withheld means the
    token was not seen in what could be read, not that it is proven absent.
    """
    return where == "unreadable file" or where.startswith("incompletely inspected")


def zip_hit(data: bytes, token: bytes, depth: int) -> str | None:
    """Name of the first zip member that holds the token, else None.

    Raises _Incomplete only when no readable member holds the token and some
    member or nested content could not be completely inspected. A hit in any
    readable member wins over incomplete content elsewhere, so the exposure
    alarm never depends on member order. Callers must treat incomplete as
    unclean, never as a miss.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except _Incomplete:
        raise
    except Exception as error:
        raise _Incomplete("unreadable archive") from error
    try:
        entries = archive.infolist()
    except _Incomplete:
        raise
    except Exception as error:
        raise _Incomplete("unreadable archive listing") from error
    first_incomplete: _Incomplete | None = None
    for info in entries:
        if info.is_dir():
            continue
        safe_name = _safe_member(info.filename, token)
        try:
            # Read by ZipInfo (header offset), never by filename: read(name)
            # resolves through NameToInfo, which keeps only the LAST entry
            # with that name, so earlier same-named members would go
            # uninspected while the last one is read twice.
            member = archive.read(info)
        except _Incomplete as error:
            if first_incomplete is None:
                first_incomplete = error
            continue
        except Exception as error:
            if first_incomplete is None:
                first_incomplete = _Incomplete(
                    f"unreadable archive member {safe_name}"
                )
            continue
        if token in member:
            return safe_name
        if member.startswith(b"PK\x03\x04"):
            if depth >= MAX_DEPTH:
                if first_incomplete is None:
                    first_incomplete = _Incomplete(
                        f"uninspected nested archive beyond depth limit in {safe_name}"
                    )
                continue
            try:
                inner = zip_hit(member, token, depth + 1)
            except _Incomplete as error:
                if first_incomplete is None:
                    first_incomplete = _Incomplete(
                        f"{safe_name}!{error.reason}"
                    )
                continue
            if inner:
                return f"{safe_name}!{inner}"
    if first_incomplete is not None:
        raise first_incomplete
    return None


def file_hit(path: str, token: bytes) -> str | None:
    """Where in the file the token sits ("file", "archive member", ...) or None.

    Incompletely inspected content returns an "incompletely inspected ..."
    reason so the caller removes the file; only completely inspected clean
    content returns None.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    if token in data:
        return "file"
    first_incomplete: str | None = None
    if data.startswith(b"PK\x03\x04"):
        try:
            member = zip_hit(data, token, 0)
        except _Incomplete as error:
            first_incomplete = f"incompletely inspected archive ({error.reason})"
            member = None
        if member:
            return f"archive member {member}"
    for match in EMBEDDED_ZIP.finditer(data):
        try:
            blob = base64.b64decode(re.sub(rb"\s", b"", match.group(1)))
        except (binascii.Error, ValueError):
            if first_incomplete is None:
                first_incomplete = (
                    "incompletely inspected embedded archive (unreadable encoding)"
                )
            continue
        if token in blob:
            return "embedded file"
        if not blob.startswith(b"PK\x03\x04"):
            continue
        try:
            member = zip_hit(blob, token, 0)
        except _Incomplete as error:
            if first_incomplete is None:
                first_incomplete = (
                    f"incompletely inspected embedded archive ({error.reason})"
                )
            continue
        if member:
            return f"embedded archive member {member}"
    if first_incomplete is not None:
        return first_incomplete
    return None


def main(directories: list[str]) -> int:
    token = os.environ.get("QA_AUTH_TOKEN", "").encode()
    if not token:
        # An empty pattern matches every file; with no token there is nothing to leak.
        print("scrub-qa-token: QA_AUTH_TOKEN is empty, nothing to sweep for", file=sys.stderr)
        mark_swept()
        return 0

    removed = 0
    withheld = 0
    stuck = 0
    stuck_withheld = 0
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
                # Never disclose the token or a tainted name in diagnostics.
                safe = _safe_path(path, token)
                if _contains_token(where, token):
                    where = "tainted finding (redacted)"
                try:
                    os.remove(path)
                except OSError:
                    print(f"scrub-qa-token: could NOT remove {safe} ({where})", file=sys.stderr)
                    if _is_withheld(where):
                        stuck_withheld += 1
                    else:
                        stuck += 1
                    continue
                print(f"scrub-qa-token: removed {safe} ({where})", file=sys.stderr)
                if _is_withheld(where):
                    withheld += 1
                else:
                    removed += 1

    if stuck or stuck_withheld:
        if stuck:
            print(
                f"::error::QA_AUTH_TOKEN is in {stuck} failure artifact file(s) that could not be "
                "removed; the artifacts must not be uploaded. Treat the token as exposed."
            )
        if stuck_withheld:
            print(
                f"::error::{stuck_withheld} failure artifact file(s) could not be fully inspected "
                "and could not be removed; the artifacts must not be uploaded."
            )
        return 2
    mark_swept()
    if removed:
        print(
            f"::error::QA_AUTH_TOKEN was found in {removed} failure artifact file(s); removed. "
            "Treat the token as exposed and report it to the COO."
        )
    if withheld:
        print(
            f"scrub-qa-token: {withheld} failure artifact file(s) could not be fully inspected "
            "and were withheld from the upload.",
            file=sys.stderr,
        )
    if removed or withheld:
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
