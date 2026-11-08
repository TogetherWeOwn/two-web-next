#!/usr/bin/env python3
"""Inspect bounded Hono or canonical evidence in memory; never extract or execute."""

import base64
import hashlib
import io
import json
import stat
import sys
import zipfile
import zlib

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024
TEXT_FILES = {
    "bundle-meta.json",
    "inventory.json",
    "upload.json",
    "deployed.json",
    "pure-hono-rollback.json",
}
REQUIRED = TEXT_FILES | {"worker.js", "worker.js.map"}
ALLOWED = REQUIRED | {"README.md"}


def safe_entry(entry, member_limit, archive_limit):
    mode = entry.external_attr >> 16
    return (
        entry.orig_filename == entry.filename
        and not entry.is_dir()
        and stat.S_IFMT(mode) in (0, stat.S_IFREG)
        and not entry.flag_bits & 1
        and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
        and 0 <= entry.file_size <= member_limit
        and 0 <= entry.compress_size <= archive_limit
    )


def read_archive(data):
    if not data or len(data) > MAX_ARCHIVE:
        raise ValueError("archive outside bounds")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (
            len(entries) > len(ALLOWED)
            or len(set(names)) != len(names)
            or not REQUIRED <= set(names) <= ALLOWED
        ):
            raise ValueError("unexpected archive members")
        total = 0
        for entry in entries:
            limit = MAX_TEXT if entry.filename in TEXT_FILES else MAX_MEMBER
            if (
                not safe_entry(entry, limit, MAX_ARCHIVE)
                or (entry.filename in REQUIRED and entry.file_size == 0)
            ):
                raise ValueError("unsafe archive member")
            total += entry.file_size
            if total > MAX_TOTAL:
                raise ValueError("archive expansion outside bounds")
        files = []
        texts = {}
        for entry in sorted(entries, key=lambda item: item.filename):
            digest = hashlib.sha256()
            size = 0
            chunks = []
            with archive.open(entry) as member:
                while True:
                    chunk = member.read(min(64 * 1024, entry.file_size - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > entry.file_size:
                        raise ValueError("member length mismatch")
                    digest.update(chunk)
                    if entry.filename in TEXT_FILES:
                        chunks.append(chunk)
            if size != entry.file_size:
                raise ValueError("member length mismatch")
            files.append({"path": entry.filename, "bytes": size, "sha256": digest.hexdigest()})
            if entry.filename in TEXT_FILES:
                texts[entry.filename] = b"".join(chunks).decode("utf-8", errors="strict")
        return {"files": files, "texts": texts}


CANONICAL_PREFIX = "artifacts/kit-canonical-capture/bytes/"
CANONICAL_ARCHIVE = 128 * 1024 * 1024


def read_canonical_archive(data):
    # Bound zipfile's central-directory allocation before it parses attacker data.
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    if not data or len(data) > CANONICAL_ARCHIVE:
        raise ValueError("archive outside bounds")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 60000 or len(set(names)) != len(names):
            raise ValueError("unexpected archive members")
        selected = []
        total = 0
        selected_total = 0
        for entry in entries:
            name = entry.filename
            if (
                not safe_entry(entry, MAX_MEMBER, CANONICAL_ARCHIVE)
                or len(name) > 1200
                or "\\" in name
                or any(ord(char) < 32 or ord(char) == 127 for char in name)
                or any(part in ("", ".", "..") for part in name.split("/"))
            ):
                raise ValueError("unsafe archive member")
            total += entry.file_size
            if total > 768 * 1024 * 1024:
                raise ValueError("archive expansion outside bounds")
            if name.startswith(CANONICAL_PREFIX):
                selected.append(entry)
                selected_total += entry.file_size
        if (
            not 1 < len(selected) <= 20001
            or selected_total > 264 * 1024 * 1024
        ):
            raise ValueError("canonical members outside bounds")
        members = []
        for entry in sorted(selected, key=lambda item: item.filename):
            path = entry.filename[len(CANONICAL_PREFIX):]
            if path == "receipt.json" and not 0 < entry.file_size <= 8 * 1024 * 1024:
                raise ValueError("receipt outside bounds")
            with archive.open(entry) as member:
                content = member.read(entry.file_size + 1)
            if len(content) != entry.file_size:
                raise ValueError("member length mismatch")
            members.append({"path": path, "type": "file", "base64": base64.b64encode(content).decode("ascii")})
        return members


if __name__ == "__main__":
    canonical = sys.argv[1:] == ["--canonical"]
    try:
        if sys.argv[1:] and not canonical:
            raise ValueError("unsupported profile")
        limit = CANONICAL_ARCHIVE if canonical else MAX_ARCHIVE
        data = sys.stdin.buffer.read(limit + 1)
        result = read_canonical_archive(data) if canonical else read_archive(data)
        sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    except (ValueError, OSError, RuntimeError, EOFError, MemoryError, OverflowError, zipfile.BadZipFile, NotImplementedError, zlib.error):
        sys.stderr.write("invalid canonical archive\n" if canonical else "invalid pure-Hono archive\n")
        sys.exit(1)
