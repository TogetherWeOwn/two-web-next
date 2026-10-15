"""Require every recognized branch floor-waiver trailer in the PR body."""

import re


_THRESHOLD_TRAILER = re.compile(r"^Floor-waiver: threshold-removed (.+?) -- (.+)$")
_PATH_TRAILER = re.compile(
    r"^Floor-waiver: (?:assertion-removed|test-deleted|new-exemption) (\S+) -- (.+)$"
)


def waiver_trailers(messages):
    waivers = set()
    for line in messages.splitlines():
        threshold = _THRESHOLD_TRAILER.fullmatch(line)
        if threshold and threshold[1].strip() and threshold[2].strip():
            waivers.add(line)
            continue
        path = _PATH_TRAILER.fullmatch(line)
        if path and path[2].strip():
            waivers.add(line)
    return waivers


def missing_body_waivers(messages, body):
    body_lines = set(body.splitlines())
    return sorted(waiver for waiver in waiver_trailers(messages) if waiver not in body_lines)
