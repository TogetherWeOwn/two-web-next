#!/usr/bin/env python3
"""Hash a bounded flat Hono evidence archive in memory; never extract or execute."""

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
            mode = entry.external_attr >> 16
            limit = MAX_TEXT if entry.filename in TEXT_FILES else MAX_MEMBER
            if (
                entry.orig_filename != entry.filename
                or entry.is_dir()
                or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                or entry.flag_bits & 1
                or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or not 0 <= entry.file_size <= limit
                or (entry.filename in REQUIRED and entry.file_size == 0)
                or not 0 <= entry.compress_size <= MAX_ARCHIVE
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


if __name__ == "__main__":
    try:
        result = read_archive(sys.stdin.buffer.read(MAX_ARCHIVE + 1))
        sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    except (ValueError, OSError, RuntimeError, EOFError, zipfile.BadZipFile, NotImplementedError, zlib.error):
        sys.stderr.write("invalid pure-Hono archive\n")
        sys.exit(1)
