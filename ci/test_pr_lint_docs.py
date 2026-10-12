"""Focused drift test: CONTRIBUTING.md fail-vs-warn classification must match pr-lint config and checker behavior.

Run with: python3 -m unittest discover -s ci -p 'test_pr_lint_docs.py'
Also wired into the `Unit-test the lint` step in .github/workflows/pr-gates.yml.
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "pr-gates.yml"
DOCS = REPO_ROOT / "CONTRIBUTING.md"
TEMPLATE = REPO_ROOT / ".github" / "pull_request_template.md"

sys.path.insert(0, str(REPO_ROOT / ".github" / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "ci"))

import pr_standards as ps  # noqa: E402

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "check_pr_conventions", str(REPO_ROOT / "ci" / "check-pr-conventions.py")
)
_conventions = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_conventions)

GOOD_BODY = """
## Linked Issues or Issue Description

Fixes #123

## Verification

- `npm test` passes: 41 passed, 0 failed
"""


def workflow_env(name):
    text = WORKFLOW.read_text(encoding="utf-8")
    match = re.search(rf'^\s*{name}:\s*"([^"]*)"', text, re.M)
    assert match, f"{name} not found in pr-gates.yml"
    return match.group(1)


def docs_table_rows():
    """Parse the fail-vs-warn table under the dedicated docs heading."""
    text = DOCS.read_text(encoding="utf-8")
    heading = "### What fails `pr-lint` today vs what only warns"
    assert heading in text, "docs heading for fail-vs-warn classification is missing"
    section = text.split(heading, 1)[1]
    # Stop at the next same-or-higher-level heading.
    cut = re.search(r"^#{1,3} ", section, re.M)
    if cut:
        section = section[: cut.start()]
    rows = []
    for line in section.splitlines():
        line = line.strip()
        if line.startswith("|") and "---" not in line and line.count("|") >= 3:
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if cells[0].lower() == "check":
                continue  # header row
            rows.append(cells)
    assert rows, "docs fail-vs-warn table has no rows"
    return section, rows


def row_result(rows, needle):
    for cells in rows:
        if needle.lower() in cells[0].lower():
            return cells[1]
    raise AssertionError(f"docs table has no row mentioning: {needle}")


def assert_fails(rows, needle):
    assert "fail" in row_result(rows, needle).lower(), (
        f"docs must classify '{needle}' as failing pr-lint"
    )


def assert_warns(rows, needle):
    result = row_result(rows, needle).lower()
    assert "warn" in result and "fail" not in result, (
        f"docs must classify '{needle}' as warn-only, got: {result}"
    )


class DocsClassification(unittest.TestCase):
    def test_docs_state_the_current_workflow_mode(self):
        internal_level = workflow_env("INTERNAL_ID_LEVEL")
        standards_mode = workflow_env("PR_STANDARDS_MODE")
        cutoff = workflow_env("HEAD_REF_ERROR_FROM_PR")
        text = DOCS.read_text(encoding="utf-8")
        for token in (
            f'INTERNAL_ID_LEVEL: "{internal_level}"',
            f'PR_STANDARDS_MODE: "{standards_mode}"',
            f'HEAD_REF_ERROR_FROM_PR: "{cutoff}"',
        ):
            self.assertIn(token, text, f"docs must state the current mode token {token}")

    def test_failing_checks_are_documented_as_failures(self):
        _, rows = docs_table_rows()
        assert_fails(rows, "Conventional Commits title")
        assert_fails(rows, "empty body")
        assert_fails(rows, "bypass commit")
        assert_fails(rows, "ratchet")
        assert_fails(rows, "branch-name internal ID")

    def test_warning_checks_are_documented_as_warnings(self):
        _, rows = docs_table_rows()
        assert_warns(rows, "Linked Issues or Issue Description")
        assert_warns(rows, "Verification")
        assert_warns(rows, "commit subject")
        assert_warns(rows, "below the cutoff")

    def test_no_required_wording_for_warn_only_sections(self):
        """The contract bullets must not call warn-only sections 'required' without the warn qualifier."""
        for path in (DOCS, TEMPLATE):
            text = path.read_text(encoding="utf-8")
            for line in text.splitlines():
                low = line.lower()
                if "linked issue" in low and "verification" in low and "requir" in low:
                    self.assertIn("warn", low, f"{path.name} still presents warn-only sections as required: {line}")

    def test_template_states_warn_mode(self):
        """The PR template is read first, so it must carry the same warn-mode contract as CONTRIBUTING.md."""
        text = TEMPLATE.read_text(encoding="utf-8")
        low = text.lower()
        self.assertIn("pr_standards_mode", low, "template must name the PR_STANDARDS_MODE knob")
        self.assertIn("warn", low, "template must state the current warn mode")
        self.assertIn('"error"', text, 'template must state the flip to "error"')
        self.assertIn("title", low, "template must note the title always fails")
        self.assertIn("empty body", low, "template must note an empty body always fails")


class CheckerBehaviorMatchesDocs(unittest.TestCase):
    def test_title_and_empty_body_fail_in_configured_mode(self):
        mode = workflow_env("PR_STANDARDS_MODE")
        bad_title = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "not conventional",
                "BODY": GOOD_BODY,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(any(f.level == "error" for f in bad_title), bad_title)
        empty_body = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refuse expired sudo sessions",
                "BODY": "<!-- nothing -->  ",
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(any(f.level == "error" for f in empty_body), empty_body)
        # First checker agrees: bad title and empty body fail regardless of warn levels.
        self.assertTrue(_conventions.check_pr("not conventional", GOOD_BODY, "alice", (), "warning"))
        self.assertTrue(
            _conventions.check_pr(
                "fix(auth): refuse expired sudo sessions", "<!-- nothing -->  ", "alice", (), "warning"
            )
        )

    def test_missing_sections_only_warn_in_configured_mode(self):
        mode = workflow_env("PR_STANDARDS_MODE")
        self.assertEqual(mode, "warn", "test expectation pins the current warn mode; update docs + test on flip")
        thin = GOOD_BODY.replace("## Verification", "## Notes")
        findings = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refuse expired sudo sessions",
                "BODY": thin,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(any(f.level == "warning" and f.title == "PR template" for f in findings), findings)
        self.assertFalse(any(f.level == "error" for f in findings), findings)
        # And they fail once the mode flips to error.
        flipped = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refuse expired sudo sessions",
                "BODY": thin,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": "error",
            }
        )
        self.assertTrue(any(f.level == "error" for f in flipped), flipped)

    def test_internal_ids_warn_in_configured_mode(self):
        level = workflow_env("INTERNAL_ID_LEVEL")
        self.assertEqual(level, "warning", "test expectation pins the current warning level; update docs + test on flip")
        self.assertFalse(
            _conventions.check_pr(
                "fix(ci): handle TOG-1234 retries", GOOD_BODY, "alice", (), level
            )
        )
        self.assertTrue(
            _conventions.check_pr(
                "fix(ci): handle TOG-1234 retries", GOOD_BODY, "alice", (), "error"
            )
        )
        mode = workflow_env("PR_STANDARDS_MODE")
        findings = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refresh the key",
                "BODY": GOOD_BODY.replace("Fixes #123", "Refs: TOG-1234"),
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(any(f.level == "warning" for f in findings), findings)
        self.assertFalse(any(f.level == "error" for f in findings), findings)

    def test_branch_cutoff_still_errors_in_warn_mode(self):
        mode = workflow_env("PR_STANDARDS_MODE")
        cutoff = workflow_env("HEAD_REF_ERROR_FROM_PR")
        clean = GOOD_BODY
        below = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refresh the key",
                "BODY": clean,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/tog-123-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
                "PR_NUMBER": str(int(cutoff) - 1),
                "HEAD_REF_ERROR_FROM_PR": cutoff,
            }
        )
        self.assertEqual([("warning", "Internal reference")], [(f.level, f.title) for f in below])
        at_cutoff = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refresh the key",
                "BODY": clean,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/tog-123-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
                "PR_NUMBER": cutoff,
                "HEAD_REF_ERROR_FROM_PR": cutoff,
            }
        )
        self.assertEqual([("error", "Internal reference")], [(f.level, f.title) for f in at_cutoff])

    def test_ratchet_growth_fails(self):
        from internal_ref_ratchet import check as ratchet_check

        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q", repo], check=True)
            subprocess.run(["git", "-C", repo, "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", repo, "config", "user.name", "test"], check=True)
            target = Path(repo) / "note.txt"
            target.write_text("hello\n", encoding="utf-8")
            subprocess.run(["git", "-C", repo, "add", "note.txt"], check=True)
            subprocess.run(["git", "-C", repo, "commit", "-qm", "docs: base note"], check=True)
            base = subprocess.run(
                ["git", "-C", repo, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
            ).stdout.strip()
            target.write_text("hello TOG-9999\n", encoding="utf-8")
            subprocess.run(["git", "-C", repo, "add", "note.txt"], check=True)
            subprocess.run(["git", "-C", repo, "commit", "-qm", "docs: add note"], check=True)
            head = subprocess.run(
                ["git", "-C", repo, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
            ).stdout.strip()
            self.assertEqual(1, ratchet_check(repo, base, head))
            self.assertEqual(0, ratchet_check(repo, base, base))

    def test_workflow_runs_this_test(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("test_pr_lint_docs.py", text, "pr-gates.yml must run this drift test")


if __name__ == "__main__":
    unittest.main()
