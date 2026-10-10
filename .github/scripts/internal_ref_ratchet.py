#!/usr/bin/env python3
"""Reject net growth of internal card IDs and instance-UI links in tracked blobs.

Compare immutable Git trees, not a diff or the working directory. Moves and splits
are net-zero. Existing references are debt, not an allowlist. Diagnostics contain
only JSON-escaped paths and counts, never blob content or Git stderr. Stdlib only.
"""
import argparse
import json
import os
import subprocess
import sys

from internal_references import DEFAULT_PREFIXES, file_reference_count

# Exact lint-fixture paths only. No directory, extension or generated-file exemptions.
LINT_FIXTURE_EXCLUSIONS = {
    ".github/scripts/test_pr_standards.py": "Synthetic PR-text violations exercise the metadata lint.",
    "ci/test_check_pr_conventions.py": "Synthetic titles, bodies and commit subjects exercise the conventions lint.",
    ".github/scripts/test_internal_ref_ratchet.py": "Synthetic tracked-file violations exercise this ratchet.",
}


class UnreadableTree(Exception):
    pass


def git(repo, *args, data=None):
    try:
        result = subprocess.run(
            ["git", "-C", os.fspath(repo), *args], input=data,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise UnreadableTree() from exc
    if result.returncode:
        raise UnreadableTree()
    return result.stdout


def tree_counts(repo, revision, prefixes=DEFAULT_PREFIXES):
    tree = git(repo, "rev-parse", "--verify", "--end-of-options", revision + "^{tree}").strip()
    entries = git(repo, "ls-tree", "-r", "-z", "--full-tree", tree.decode("ascii"))
    blobs = []
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        name = path.decode("utf-8", "surrogateescape")
        if name in LINT_FIXTURE_EXCLUSIONS:
            continue
        # Symlinks are blobs too: scan the target bytes without following them.
        # A submodule's tracked content cannot be read here; don't silently skip it.
        if kind != b"blob" or mode not in (b"100644", b"100755", b"120000"):
            raise UnreadableTree()
        blobs.append((name, oid))
    if not blobs:
        return {}
    batch = git(repo, "cat-file", "--batch", data=b"".join(oid + b"\n" for _, oid in blobs))
    counts, offset = {}, 0
    for name, oid in blobs:
        end = batch.find(b"\n", offset)
        if end < 0:
            raise UnreadableTree()
        header = batch[offset:end].split()
        if len(header) != 3 or header[:2] != [oid, b"blob"] or not header[2].isdigit():
            raise UnreadableTree()
        size = int(header[2])
        start, stop = end + 1, end + 1 + size
        if stop >= len(batch) or batch[stop:stop + 1] != b"\n":
            raise UnreadableTree()
        # Do not ignore binary or invalid-UTF-8 blobs: ASCII references still count.
        counts[name] = file_reference_count(batch[start:stop].decode("utf-8", "surrogateescape"), prefixes)
        offset = stop + 1
    if offset != len(batch):
        raise UnreadableTree()
    return counts


def check(repo, base, head="HEAD", prefixes=DEFAULT_PREFIXES):
    snapshots = []
    for label, revision in (("base", base), ("head", head)):
        try:
            snapshots.append(tree_counts(repo, revision, prefixes))
        except UnreadableTree:
            print(f"Cannot read the {label} tracked tree; refusing to pass.")
            return 1
    before, after = snapshots
    if sum(after.values()) <= sum(before.values()):
        print("Internal reference ratchet OK")
        return 0
    for name in sorted(set(before) | set(after)):
        if before.get(name, 0) != after.get(name, 0):
            # JSON quoting also prevents newlines/control bytes becoming workflow commands.
            print(f"{json.dumps(name, ensure_ascii=True)}\tbase={before.get(name, 0)}\thead={after.get(name, 0)}")
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="PR base SHA (missing/unreadable fails closed)")
    parser.add_argument("--head", default="HEAD", help="PR head SHA or a staged tree from git write-tree")
    args = parser.parse_args()
    return check(".", args.base, args.head, os.environ.get("INTERNAL_ID_PREFIXES") or DEFAULT_PREFIXES)


if __name__ == "__main__":
    sys.exit(main())
