"""Require every recognized branch floor-waiver trailer in the PR body."""

import re


# Merge-queue squash messages hard-wrap the PR body at ~72 columns, so a long
# trailer arrives as a first line plus non-blank continuation lines. Unfold
# those continuations before matching. Real paths never contain spaces, so
# wrap-inserted spaces inside the path are stripped; other whitespace
# collapses to single spaces for a canonical comparison on both sides.
_THRESHOLD_TRAILER = re.compile(r"^Floor-waiver: threshold-removed (.+?) -- (.+)$")
_PATH_TRAILER = re.compile(
    r"^Floor-waiver: (assertion-removed|test-deleted|new-exemption) (.+?) -- (.+)$"
)


def _unfold_lines(text):
    lines = text.splitlines()
    unfolded = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("Floor-waiver:"):
            block = line
            j = i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].startswith("Floor-waiver:"):
                block += " " + lines[j].strip()
                j += 1
            unfolded.append(block)
            i = j
        else:
            unfolded.append(line)
            i += 1
    return unfolded


def _canonicalize(block):
    norm = re.sub(r"\s+", " ", block).strip()
    threshold = _THRESHOLD_TRAILER.fullmatch(norm)
    if threshold and threshold.group(1).strip() and threshold.group(2).strip():
        return f"Floor-waiver: threshold-removed {threshold.group(1).strip()} -- {threshold.group(2).strip()}"
    path = _PATH_TRAILER.fullmatch(norm)
    if path and path.group(3).strip():
        clean_path = re.sub(r"\s+", "", path.group(2))
        if not clean_path:
            return None
        return f"Floor-waiver: {path.group(1)} {clean_path} -- {path.group(3).strip()}"
    return None


def waiver_trailers(messages):
    waivers = set()
    for block in _unfold_lines(messages):
        canonical = _canonicalize(block)
        if canonical:
            waivers.add(canonical)
    return waivers


def missing_body_waivers(messages, body):
    body_waivers = waiver_trailers(body)
    return sorted(waiver for waiver in waiver_trailers(messages) if waiver not in body_waivers)
