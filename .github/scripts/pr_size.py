#!/usr/bin/env python3
"""Advisory pull-request size labels: size/S, size/M, size/L, size/XL.

Deterministic and advisory only. The workflow that runs this script is not a
required check and never blocks a merge: any API failure is a warning and an
exit code of 0. The point is a visible nudge - large pull requests are harder
to review well - plus a countable record (the labels) for a weekly tally.

Size is additions + deletions over the files the pull-request API reports,
excluding lockfiles, generated files and fixtures (see EXCLUDED below; a repo
adds its own generated paths with PR_SIZE_EXCLUDE_EXTRA). A renamed file is
judged by its new path. Binary files report 0 additions/deletions in the API,
so images and other binaries never inflate the count.

Modes (first argument):
  label   Label one pull request and keep one advisory comment when the
          counted size is over the threshold (default: this mode).
  weekly  Count pull requests merged in the last 7 days by size label and
          print the tally (also appended to $GITHUB_STEP_SUMMARY when set).

Environment contract (every value is a plain string):
  GH_TOKEN               token for the GitHub API (the workflow's GITHUB_TOKEN)
  REPO                   "owner/name"
  PR_NUMBER              label mode only: the pull request number
  PR_SIZE_THRESHOLD      counted lines above which the comment posts (default 400)
  PR_SIZE_EXCLUDE_EXTRA  comma-separated extra exclusion globs for this repo
  GITHUB_API_URL         API base (default https://api.github.com)
  GITHUB_STEP_SUMMARY    optional path the weekly tally is appended to

Stdlib only, so the same file runs unchanged in every repository that adopts
the advisory: copy pr_size.py, test_pr_size.py and pr-size.yml together.
"""
import fnmatch
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

MARKER = "<!-- pr-size-advisory -->"
DEFAULT_THRESHOLD = 400

# (label suffix, largest counted size with that label, label colour)
SIZES = [
    ("S", 100, "0E8A16"),
    ("M", 400, "FBCA04"),
    ("L", 1000, "D93F0B"),
    ("XL", None, "B60205"),
]
SIZE_LABELS = [f"size/{suffix}" for suffix, _cap, _colour in SIZES]

LOCKFILE_BASENAMES = {
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "flake.lock",
    "go.sum",
}

# Globs are matched against the whole path and, for patterns without a slash,
# the basename. `**/` also matches zero directories (see is_excluded).
EXCLUDED_GLOBS = [
    # any remaining lockfile shape not named above
    "*.lock",
    # generated: minified bundles and sourcemaps
    "*.min.js",
    "*.min.css",
    "*.map",
    # generated: test snapshots
    "**/__snapshots__/**",
    "*.snap",
    # generated / vendored trees committed in some repositories
    "**/dist/**",
    "**/vendor/**",
    "**/node_modules/**",
    # fixtures and recorded test data
    "**/fixtures/**",
    "**/__fixtures__/**",
    "**/testdata/**",
    "**/test-data/**",
]


def _glob_variants(pattern):
    """fnmatch has no `**`; expand it to the two shapes it must cover."""
    variants = [pattern]
    if pattern.startswith("**/"):
        variants.append(pattern[3:])
    return variants


def is_excluded(path, extra_globs=()):
    basename = path.rsplit("/", 1)[-1]
    if basename in LOCKFILE_BASENAMES:
        return True
    for pattern in [*EXCLUDED_GLOBS, *extra_globs]:
        for variant in _glob_variants(pattern):
            if fnmatch.fnmatchcase(path, variant):
                return True
            if "/" not in variant and fnmatch.fnmatchcase(basename, variant):
                return True
    return False


def size_label(counted):
    for suffix, cap, _colour in SIZES:
        if cap is None or counted <= cap:
            return f"size/{suffix}"
    raise AssertionError("unreachable: XL has no cap")


def count_files(files, extra_globs=()):
    """files: API file objects. Returns (counted, excluded, counted_files)."""
    counted = 0
    excluded = 0
    counted_files = 0
    for entry in files:
        lines = int(entry.get("additions", 0)) + int(entry.get("deletions", 0))
        if is_excluded(entry.get("filename", ""), extra_globs):
            excluded += lines
        else:
            counted += lines
            counted_files += 1
    return counted, excluded, counted_files


def comment_body(counted, excluded, counted_files, threshold):
    files_word = "file" if counted_files == 1 else "files"
    lines = [
        MARKER,
        "## Pull request size (advisory)",
        "",
        f"This pull request changes **{counted} counted lines** across "
        f"{counted_files} {files_word}, over the {threshold}-line advisory threshold "
        f"({excluded} further lines in lockfiles, generated files and "
        "fixtures are not counted).",
        "",
        "Smaller pull requests get faster, more careful review. If this change "
        "can be split into independently mergeable pieces, please consider "
        "splitting it; if it cannot, no action is needed.",
        "",
        "_Advisory only: this comment and the `size/*` label never block a merge._",
    ]
    return "\n".join(lines) + "\n"


def under_body(counted, threshold):
    lines = [
        MARKER,
        "## Pull request size (advisory)",
        "",
        f"This pull request is back under the {threshold}-line advisory "
        f"threshold ({counted} counted lines). Thank you.",
        "",
        "_Advisory only: this comment and the `size/*` label never block a merge._",
    ]
    return "\n".join(lines) + "\n"


def tally(items):
    """Count search-result items (merged PRs) by their size label."""
    counts = {label: 0 for label in SIZE_LABELS}
    counts["unlabelled"] = 0
    for item in items:
        names = [label.get("name", "") for label in item.get("labels", [])]
        found = [name for name in names if name in counts and name != "unlabelled"]
        if found:
            counts[found[0]] += 1
        else:
            counts["unlabelled"] += 1
    return counts


def weekly_report(counts, since):
    total = sum(counts.values())
    over = counts["size/L"] + counts["size/XL"]
    rows = [
        "## Weekly pull-request size tally",
        "",
        f"Pull requests merged since {since}: **{total}** "
        f"({over} over the advisory threshold).",
        "",
        "| Label | Merged |",
        "|---|---|",
    ]
    rows += [f"| `{label}` | {counts[label]} |" for label in SIZE_LABELS]
    rows.append(f"| (no size label) | {counts['unlabelled']} |")
    return "\n".join(rows) + "\n"


class ApiError(Exception):
    pass


class GitHubApi:
    def __init__(self, token, repo, base="https://api.github.com"):
        self.token = token
        self.repo = repo
        self.base = base.rstrip("/")

    def request(self, method, path, body=None):
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise ApiError(f"{method} {path} -> HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ApiError(f"{method} {path} -> {exc}") from exc

    def paged(self, path):
        items = []
        page = 1
        while True:
            sep = "&" if "?" in path else "?"
            batch = self.request("GET", f"{path}{sep}per_page=100&page={page}")
            if isinstance(batch, dict):  # search API shape
                batch = batch.get("items", [])
            items.extend(batch)
            if len(batch) < 100:
                return items
            page += 1

    def pr_files(self, number):
        return self.paged(f"/repos/{self.repo}/pulls/{number}/files")

    def pr_labels(self, number):
        pr = self.request("GET", f"/repos/{self.repo}/pulls/{number}")
        return [label.get("name", "") for label in pr.get("labels", [])]

    def ensure_label(self, name):
        suffix, _cap, colour = next(
            row for row in SIZES if f"size/{row[0]}" == name
        )
        description = f"Pull request size: {suffix} (advisory, counted lines)"
        try:
            self.request(
                "POST",
                f"/repos/{self.repo}/labels",
                {"name": name, "color": colour, "description": description},
            )
        except ApiError as exc:
            if "HTTP 422" not in str(exc):  # 422: label already exists
                raise

    def add_label(self, number, name):
        self.request(
            "POST", f"/repos/{self.repo}/issues/{number}/labels", {"labels": [name]}
        )

    def remove_label(self, number, name):
        quoted = urllib.parse.quote(name, safe="")
        self.request("DELETE", f"/repos/{self.repo}/issues/{number}/labels/{quoted}")

    def find_marker_comment(self, number):
        for comment in self.paged(f"/repos/{self.repo}/issues/{number}/comments"):
            if MARKER in (comment.get("body") or ""):
                return comment
        return None

    def upsert_comment(self, number, body):
        existing = self.find_marker_comment(number)
        if existing is not None:
            if (existing.get("body") or "") != body:
                self.request(
                    "PATCH",
                    f"/repos/{self.repo}/issues/comments/{existing['id']}",
                    {"body": body},
                )
            return "updated"
        self.request(
            "POST", f"/repos/{self.repo}/issues/{number}/comments", {"body": body}
        )
        return "created"

    def merged_since(self, since):
        query = urllib.parse.quote(f"repo:{self.repo} is:pr is:merged merged:>={since}")
        return self.paged(f"/search/issues?q={query}")


def label_pr(api, number, threshold, extra_globs, log=print):
    files = api.pr_files(number)
    counted, excluded, counted_files = count_files(files, extra_globs)
    label = size_label(counted)
    log(
        f"PR #{number}: {counted} counted lines ({counted_files} files), "
        f"{excluded} excluded lines -> {label}"
    )
    api.ensure_label(label)
    current = api.pr_labels(number)
    for stale in SIZE_LABELS:
        if stale != label and stale in current:
            api.remove_label(number, stale)
    if label not in current:
        api.add_label(number, label)
    if counted > threshold:
        api.upsert_comment(
            number, comment_body(counted, excluded, counted_files, threshold)
        )
    elif api.find_marker_comment(number) is not None:
        api.upsert_comment(number, under_body(counted, threshold))
    return label, counted


def weekly_since(now):
    """Start of the weekly window: a true 7 days before `now` (UTC).

    A date-only value would be searched as `merged:>=YYYY-MM-DD` (midnight),
    so a Monday 07:17 run would cover 7 days + 7 hours and the next run
    would recount that morning's merges. Keep the full timestamp.
    """
    return (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")


def weekly(api, log=print):
    since = weekly_since(datetime.now(timezone.utc))
    report = weekly_report(tally(api.merged_since(since)), since)
    log(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(report)
    return report


def main(argv):
    mode = argv[1] if len(argv) > 1 else "label"
    repo = os.environ.get("REPO", "")
    api = GitHubApi(
        os.environ.get("GH_TOKEN", ""),
        repo,
        os.environ.get("GITHUB_API_URL", "https://api.github.com"),
    )
    try:
        if mode == "weekly":
            weekly(api)
        elif mode == "label":
            threshold = int(os.environ.get("PR_SIZE_THRESHOLD", DEFAULT_THRESHOLD))
            extra = [
                glob.strip()
                for glob in os.environ.get("PR_SIZE_EXCLUDE_EXTRA", "").split(",")
                if glob.strip()
            ]
            label_pr(api, int(os.environ["PR_NUMBER"]), threshold, extra)
        else:
            print(f"::warning::pr_size: unknown mode {mode!r}; nothing done.")
    except (ApiError, KeyError, ValueError) as exc:
        # Advisory only: a labelling failure must never turn a run red.
        print(f"::warning::pr_size advisory skipped: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
