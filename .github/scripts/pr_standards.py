#!/usr/bin/env python3
"""PR standards gate: Conventional Commits title, upstream-shaped body, no internal refs on public repos.

Runs inside the existing required `pr-lint` job, so adopting it adds no new required check and
needs no ruleset change. Stdlib only. Adapted from the PR quality gates in paperclipai/paperclip
(`.github/scripts/check-pr-*.mjs`, MIT): same section names, same skip-by-type rules, same
"no internal issue references" rule. Greptile, the commitperclip bot, lockfile and AWS routing
parts of upstream are deliberately not adopted.

Environment contract (every value is a plain string):
  EVENT                  pull_request | push | workflow_dispatch   (anything but pull_request lints commits)
  TITLE, BODY, AUTHOR    pull request title, body, author login
  HEAD_REF               pull request head branch name
  COMMITS                JSON array of {id, message} for push events
  REPO_PRIVATE           "true" | "false"; decides whether internal ticket references are allowed
  REQUIRE_CARD_REF       "true" | "false"; private repos only: demand `Refs: TOG-1234` in the body
  PR_STANDARDS_MODE      "warn" | "error"; level for the upstream body/branch/reference rules (default warn)
  PR_VERIFICATION_MODE  "warn" | "error"; optional override for the Verification section
  INTERNAL_ID_PREFIXES   regex alternation of internal ticket prefixes (default TOG|PAP|PAPA)

Title format, an empty body and a missing required card reference are always errors: they are the
standard the org already enforces. On a public repo the strict title/body subset (tracker ids,
instance UI links, the internal host) also always fails, comments included. Tracker ids and
instance UI links match case-sensitively in prose; the internal host matches
case-insensitively (hostnames are case-insensitive). Everything else new
follows `PR_STANDARDS_MODE`, with a separate override for Verification.
"""
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass
from itertools import dropwhile

from internal_references import DEFAULT_PREFIXES, INSTANCE_UI, ticket_id_pattern

TYPES = "feat|fix|perf|refactor|test|docs|build|ci|chore|revert|style|security"
HEADER = re.compile(rf"^({TYPES})(\([A-Za-z0-9._/,-]+\))?!?: \S.*$")
HELP = (
    "Expected a Conventional Commits header, e.g. 'fix(auth): refuse expired sudo sessions' or "
    "'feat(events): shareable event page'. Allowed types: " + TYPES.replace("|", ", ") + "."
)

# Types that need neither a linked issue nor the duplicate-search tick (upstream SKIP_ISSUE_PREFIXES).
LIGHT_TYPES = {"docs", "chore", "build", "ci", "style", "test", "revert"}

REQUIRED_SECTIONS = [
    # (heading, minimum real items, skipped for LIGHT_TYPES)
    # Pipeline review 2026-10-10: only what a reviewer or a deterministic gate needs. The tracked card or
    # issue, and the test evidence. Thinking Path, What Changed, Risks, Model Used and the checklist ticks
    # are optional prose; the reviewers read the diff itself.
    ("Linked Issues or Issue Description", 1, True),
    ("Verification", 1, False),
]

COMMENT = re.compile(r"<!--.*?-->", re.S)
VERIFICATION_BULLET = re.compile(r"^ *(?:[-+*]|[0-9]{1,9}[.)])(?: +|$)")
QUOTE_PREFIX = re.compile(r"^(?: {0,3}> ?)+")
FENCED_BLOCK = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ `~\t]*$|\Z)", re.M | re.S)
INLINE_CODE = re.compile(r"(?<![\\`])(`+)(?!`).+?(?<!`)\1(?!`)", re.S)
COMMAND = re.compile(r"(?:[A-Za-z_][\w.-]*(?:/[^\s]+)?|(?:\.{1,2}/|/)[^\s]+)")
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
COMMAND_PLACEHOLDER = re.compile(r"^(?:\$\s+)?(?:cmd|command|test command|example|todo|tbd)\b|<\w[\w -]*>|(?:^|\s)\.{3}(?:$|\s)", re.I)
COMMAND_INTRO = re.compile(r"\b(?:ran|running|executed|using|with|via|under|by|command)\s*:?\s*$", re.I)
RESULT = re.compile(
    r"\b(?:passes|passed|fails|failed|succeeded|reproduced|matched|confirmed|found|"
    r"accepted|rejected|detected|timed out|exited)\b|"
    r"\b(?:returned|reported|produced)\b\s+(?!(?:pending|todo|tbd)\b)\w|"
    r"\bexit(?: code| status)?\s*[:=]?\s*\d+\b|"
    r"(?:[:–—-]\s*|^)(?:pass|fail|success|failure)\b", re.I,
)
RESULT_PLACEHOLDER = re.compile(
    r"\b(?:(?:not|never)\s+(?:(?:yet|been)\s+)*(?:run|executed|passed|failed|reproduced|confirmed|returned)|"
    r"(?:expected\s+(?:result|to)|(?:will|should|would|must)\s+\w+))\b[^.;\n]*", re.I,
)
# Scan complete link destinations or bare URL tokens, then validate the whole destination.
EVIDENCE_LINK = re.compile(
    r"!?\[[^\]\n]*\]\((?P<inline><[^\s<>]+>|[^\s<>)]+)(?:[ \t]+\"[^\"\n]*\")?\)|"
    r"!?\[(?P<label>[^\]\n]+)\](?:\[(?P<ref>[^\]\n]*)\])?|"
    r"(?:^|(?<=[\s(<]))(?P<bare>https?://[^\s<>\])]+)", re.I,
)
LINK_DEFINITION = re.compile(
    r"^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^\s<>]+>|[^\s<>]+)(?:[ \t]+\"[^\"\n]*\")?[ \t]*$", re.M,
)
ACTIONS_URL = re.compile(
    r"(?i:https://github\.com)/[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*/(?!\.{1,2}/)[a-zA-Z0-9_.-]+"
    r"/actions/runs/[1-9][0-9]*"
    r"(?:/(?:job|attempts)/[1-9][0-9]*)?/?(?:[?#][^\s<>]*)?"
)

# Instance-local references a public contributor cannot open (upstream "No Internal Issue References").
# The ticket-id pattern is built per call from INTERNAL_ID_PREFIXES; these are the fixed ones.
#
# Forward control (public-text lint): on a public repo the PR title and body must not carry a
# strict tracker id, an instance UI link, or the internal host. Those three always fail the
# title/body check, regardless of PR_STANDARDS_MODE.
# The remaining fixed patterns (agent links, localhost, private-network addresses, tailnet names)
# stay at PR_STANDARDS_MODE: they are common in legitimate verification prose.
HOST_INTERNAL = (re.compile(r"\binfextion\.net\b", re.I), "the internal Paperclip host")
STRICT_FIXED = [INSTANCE_UI, HOST_INTERNAL]
OTHER_FIXED = [
    (re.compile(r"\bagent://"), "an agent:// link"),
    (re.compile(r"\b(?:localhost|127\.0\.0\.1)\b"), "a localhost URL"),
    (re.compile(r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b"),
     "a private-network address"),
    (re.compile(r"\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b"), "a tailnet hostname"),
]
# Single source per pattern: the commit/branch check sees the advisory remainder plus the
# strict subset, so a leak caught in a title is also caught in a commit message and vice versa.
FIXED_INTERNAL = OTHER_FIXED + STRICT_FIXED


@dataclass
class Finding:
    level: str  # "error" | "warning"
    title: str
    message: str


def pr_type(title):
    m = re.match(rf"^({TYPES})(?:\([^)]*\))?!?:", title or "")
    return m.group(1) if m else None


def header_errors(text):
    errs = []
    if not HEADER.match(text):
        errs.append("not a Conventional Commits header")
    if len(text) > 100:
        errs.append(f"{len(text)} chars (max 100)")
    if text.rstrip().endswith("."):
        errs.append("ends with a period")
    return errs


def strip_comments(text):
    return COMMENT.sub("", text or "")


def description_text(body):
    link = r"(?:https://github\.com/TogetherWeOwn/two-web-next/pull/[1-9][0-9]*)?#issuecomment-[1-9][0-9]*"
    space = r"(?:[ \t]+|[ \t]*\r?\n[ \t]*)"
    label = rf"\[Exact-head{space}Actions{space}evidence\]"
    return re.sub(rf"^[ \t]*(?:(?:[-+*]|[0-9]+[.)])[ \t]+)?{label}\({link}\)[ \t\r]*$", "", strip_comments(body), flags=re.M)


def parse_sections(body):
    """Map normalised `## Heading` -> content. Comments are removed first."""
    sections, current, buf = {}, None, []

    def record():
        content = "\n".join(buf)
        if current == "verification" and current in sections:
            content = sections[current] + "\n\n" + content
        sections[current] = content.strip("\n") if current == "verification" else content.strip()

    for line in strip_comments(body).splitlines():
        m = re.match(r"^##\s+(.+?)\s*#*\s*$", line)
        if m:
            if current is not None:
                record()
            current, buf = m.group(1).strip().lower(), []
        elif current is not None:
            buf.append(line)
    if current is not None:
        record()
    return sections


def real_items(content):
    """Count meaningful items: bullets, quoted bullets or prose lines, minus placeholders."""
    n = 0
    for raw in content.splitlines():
        line = re.sub(r"^\s*(?:>\s*)*(?:[-*]\s+|\d+[.)]\s+)?", "", raw).strip()
        line = re.sub(r"^\[[ xX]\]\s*", "", line)
        if len(line) < 6 or line in {"-", "_No response_"}:
            continue
        if re.fullmatch(r"\[[^\]]*\]", line):  # `[Which subsystem is involved]`
            continue
        if line.endswith((" ...", " …")):  # `This pull request ...`
            continue
        n += 1
    return n


def reference_label(label):
    return " ".join(label.split()).casefold()


def is_command(text):
    command = text.strip()
    if COMMAND_PLACEHOLDER.search(command):
        return False
    try:
        args = shlex.split(command)
    except ValueError:
        return False
    prompted = args[:1] == ["$"]
    args = dropwhile(ASSIGNMENT.match, args[1:] if prompted else args)
    program = next(args, "")
    return bool(COMMAND.fullmatch(program) and (
        prompted or "/" in program or program in {"make", "pytest", "tsc", "vitest"} or next(args, None)
    ))


def has_verification_evidence(item, references):
    prose = INLINE_CODE.sub(" CODE ", item)
    for link in EVIDENCE_LINK.finditer(prose):
        destination = link["inline"] or (link["bare"] or "").rstrip(".,;:!?")
        if link["label"]:
            destination = references.get(reference_label(link["ref"] or link["label"]), "")
        if not link[0].startswith("!") and ACTIONS_URL.fullmatch(destination.strip("<>")):
            return True
    result = RESULT_PLACEHOLDER.sub(" ", EVIDENCE_LINK.sub(" ", prose))
    if not RESULT.search(result):
        return False
    for span in INLINE_CODE.finditer(item):
        prefix = item[:span.start()]
        if RESULT.search(prefix) and not COMMAND_INTRO.search(prefix):
            continue
        width = len(span[1])
        if is_command(span[0][width:-width]):
            return True
    return False


def verification_items(content):
    """Keep wrapped text and indented paragraphs with their own list item."""
    lines, indent = [], None
    for raw in content.expandtabs(4).splitlines():
        line = QUOTE_PREFIX.sub("", raw)
        bullet = VERIFICATION_BULLET.match(line)
        separated = lines and not lines[-1] and line.strip()
        if lines and (bullet or (separated and (indent is None or len(line) - len(line.lstrip()) < indent))):
            yield "\n".join(lines)
            lines, indent = [], None
        if bullet:
            indent = bullet.end()
            lines.append(line[indent:])
        elif lines or line.strip():
            lines.append(line.strip())
    if lines:
        yield "\n".join(lines)


def invalid_verification_items(content, body):
    references = {}
    for definition in LINK_DEFINITION.finditer(FENCED_BLOCK.sub("", body)):
        references.setdefault(reference_label(definition[1]), definition[2])
    items = list(verification_items(LINK_DEFINITION.sub("", FENCED_BLOCK.sub("", content))))
    return [n for n, item in enumerate(items or [""], 1) if not has_verification_evidence(item, references)]


def internal_hits(text, prefixes, slug=False):
    """Ticket ids are case-sensitive in prose (`tog-1` is plain text there). A branch name is a slug that
    tooling lowercases (`qa/tog-1-fix`), so pass `slug=True` to match any case and to count `_` as a separator."""
    text = strip_comments(text)
    hits = []
    m = ticket_id_pattern(prefixes, slug).search(text)
    if m:
        hits.append(f"ticket id {m.group(0)}")
    for pat, label in FIXED_INTERNAL:
        if pat.search(text):
            hits.append(label)
    return hits


def strict_hits(text, prefixes):
    """Fail-closed subset for public title/body: tracker ids, instance UI links, internal host.

    Tracker ids and instance UI links stay case-sensitive in prose; the internal host
    matches case-insensitively (hostnames are case-insensitive). Returns label strings
    naming each strict hit, without echoing the matched value. The raw text is scanned:
    an id, link or host inside an HTML comment is still published text."""
    hits = []
    m = ticket_id_pattern(prefixes, slug=False).search(text)
    if m:
        hits.append(f"ticket id {m.group(0)}")
    for pat, label in STRICT_FIXED:
        if pat.search(text):
            hits.append(label)
    return hits


def other_hits(text):
    """Advisory remainder for public title/body: agent links, localhost, private nets, tailnet."""
    text = strip_comments(text)
    return [label for pat, label in OTHER_FIXED if pat.search(text)]


def check_pull_request(env):
    mode = "error" if env.get("PR_STANDARDS_MODE", "warn").strip().lower() == "error" else "warning"
    verification_mode = {"error": "error", "warn": "warning"}.get(
        env.get("PR_VERIFICATION_MODE", "").strip().lower(), mode
    )
    prefixes = env.get("INTERNAL_ID_PREFIXES") or DEFAULT_PREFIXES
    private = env.get("REPO_PRIVATE", "true").strip().lower() == "true"
    title = (env.get("TITLE") or "").strip()
    body = env.get("BODY") or ""
    author = env.get("AUTHOR") or ""
    head_ref = env.get("HEAD_REF") or ""
    out = []

    if author.endswith("[bot]") and author.startswith(("dependabot", "renovate")):
        if header_errors(title):
            out.append(Finding("warning", "PR title", f"{author} title '{title}' is not conventional; set "
                               "commit-message.prefix (e.g. chore(deps)) in the bot config."))
        return out
    generated = head_ref.startswith("release-please--")

    errs = header_errors(title)
    if errs:
        out.append(Finding("error", "PR title", f"'{title}': {'; '.join(errs)}. {HELP}"))

    plain = description_text(body)
    if len(re.sub(r"\s", "", plain)) < 40:
        out.append(Finding("error", "PR body", "The description is empty. Fill in the PR template: the linked card or issue and "
                           "how it was verified."))
    elif not generated:
        ptype = pr_type(title)
        light = ptype in LIGHT_TYPES
        sections = parse_sections(plain)
        for heading, minimum, skip_light in REQUIRED_SECTIONS:
            if skip_light and light:
                continue
            content = sections.get(heading.lower())
            level = verification_mode if heading == "Verification" else mode
            if content is None:
                out.append(Finding(level, "PR template", f"Missing section '## {heading}'."))
                continue
            if real_items(content) < minimum:
                need = f"at least {minimum} items" if minimum > 1 else "real content"
                out.append(Finding(level, "PR template", f"'## {heading}' needs {need}."))
            elif heading == "Verification":
                invalid = invalid_verification_items(content, plain)
                if invalid:
                    numbers = ", ".join(map(str, invalid))
                    out.append(Finding(level, "PR template", f"'## Verification' needs a code-formatted command "
                                       f"with its observed result or a GitHub Actions run/job URL in each item "
                                       f"(missing in: {numbers})."))

    if private:
        if not generated and not re.search(r"\bTOG-\d+\b", body):
            level = "error" if env.get("REQUIRE_CARD_REF", "true").strip().lower() == "true" else "warning"
            out.append(Finding(level, "Card reference", "Add 'Refs: TOG-1234' to the PR body."))
    else:
        # Titles and bodies: the strict subset (tracker id, instance UI link, internal host)
        # always fails; the advisory remainder follows PR_STANDARDS_MODE. Branch names keep
        # the existing cutoff behavior; commit history is out of scope for this gate.
        for where, text in (("title", title), ("body", body)):
            strict = strict_hits(text, prefixes)
            if strict:
                out.append(Finding("error", "Internal reference",
                                   f"The PR {where} holds {', '.join(strict)}. Public "
                                   "repos carry no internal references: say it in plain words, link only public "
                                   "GitHub issues, and name the branch after the change (fix/short-slug)."))
            rest = other_hits(text)
            if rest:
                out.append(Finding(mode, "Internal reference",
                                   f"The PR {where} holds {', '.join(rest)}. Public "
                                   "repos carry no internal references: say it in plain words, link only public "
                                   "GitHub issues, and name the branch after the change (fix/short-slug)."))
        hits = internal_hits(head_ref, prefixes, slug=True)
        if hits:
            level = mode
            cutoff = (env.get("HEAD_REF_ERROR_FROM_PR") or "").strip()
            pr_num_str = (env.get("PR_NUMBER") or "0").strip()
            try:
                pr_num = int(pr_num_str) if pr_num_str else 0
                cutoff_num = int(cutoff) if cutoff else 0
                if cutoff_num > 0 and pr_num >= cutoff_num:
                    level = "error"
            except ValueError:
                pass
            out.append(Finding(level, "Internal reference",
                               f"The PR branch name holds {', '.join(hits)}. Public "
                               "repos carry no internal references: say it in plain words, link only public "
                               "GitHub issues, and name the branch after the change (fix/short-slug)."
                               " Push the same SHA with "
                               "`git push origin HEAD:refs/heads/<type>/<short-slug>` "
                               "and open the PR from that ref."))
    return out


def check_commits(env):
    mode = "error" if env.get("PR_STANDARDS_MODE", "warn").strip().lower() == "error" else "warning"
    prefixes = env.get("INTERNAL_ID_PREFIXES") or DEFAULT_PREFIXES
    private = env.get("REPO_PRIVATE", "true").strip().lower() == "true"
    out = []
    try:
        commits = json.loads(env.get("COMMITS") or "[]") or []
    except ValueError:
        commits = []
    for c in commits:
        message = c.get("message") or ""
        subject = message.splitlines()[0] if message else ""
        if subject.startswith(("Merge ", 'Revert "')):
            continue
        short = (c.get("id") or "")[:10]
        errs = header_errors(subject)
        if errs:
            out.append(Finding("error", "Commit on main", f"{short} '{subject}': {'; '.join(errs)}. Merge PRs with "
                               "squash and the PR title as the commit title."))
        if not private:
            hits = internal_hits(message, prefixes)
            if hits:
                out.append(Finding(mode, "Internal reference", f"Commit {short} holds {', '.join(hits)}. Public "
                                   "history carries no internal references."))
    return out


def evaluate(env):
    return check_pull_request(env) if env.get("EVENT") == "pull_request" else check_commits(env)


def _escape(text):
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(env=None):
    env = dict(os.environ) if env is None else env
    findings = evaluate(env)
    for f in findings:
        print(f"::{f.level} title={_escape(f.title)}::{_escape(f.message)}")
    if any(f.level == "error" for f in findings):
        return 1
    print("PR conventions OK" if not findings else "PR conventions OK (warnings above)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
