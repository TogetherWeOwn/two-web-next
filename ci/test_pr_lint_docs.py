"""Focused drift test: CONTRIBUTING.md fail-vs-warn classification must match pr-lint config and checker behavior.

Run with: python3 -m unittest discover -s ci -p 'test_pr_lint_docs.py'
Also wired into the `Unit-test the lint` step in .github/workflows/pr-gates.yml.
"""

import os
import contextlib
import io
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


def check_pr_quiet(*args, **kwargs):
    """Run check_pr without leaking ::error/::warning annotations into the job log."""
    with contextlib.redirect_stdout(io.StringIO()):
        return _conventions.check_pr(*args, **kwargs)


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


def assert_no_bare_required_claim(text, name):
    """Fail when a docs block presents warn-only sections as required.

    Each blank-line-separated block is further split at list-item starts,
    then whitespace-collapsed before matching, so a bare `requires` claim in
    one bullet cannot hide behind a `warns` qualifier in a neighbouring
    bullet, and hard-wrapped prose (e.g. the old two-line "`pr-lint`
    requires the title, the linked issue ..." / "and Verification;"
    template wording) is caught as well as single-line claims.
    """
    for block in re.split(r"\n\s*\n", text):
        for piece in re.split(r"(?m)^(?=\s*(?:[-*] |\d+\. ))", block):
            if not piece.strip():
                continue
            collapsed = re.sub(r"\s+", " ", piece).lower()
            if "linked issue" in collapsed and "verification" in collapsed and "requir" in collapsed:
                assert "warn" in collapsed, (
                    f"{name} still presents warn-only sections as required: {collapsed.strip()[:200]}"
                )


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
        assert_fails(rows, "strict subset")

    def test_warning_checks_are_documented_as_warnings(self):
        _, rows = docs_table_rows()
        assert_warns(rows, "Linked Issues or Issue Description")
        assert_warns(rows, "Verification")
        assert_warns(rows, "commit subject")
        assert_warns(rows, "below the cutoff")

    def test_no_required_wording_for_warn_only_sections(self):
        """The contract bullets must not call warn-only sections 'required' without the warn qualifier."""
        for path in (DOCS, TEMPLATE):
            assert_no_bare_required_claim(path.read_text(encoding="utf-8"), path.name)

    def test_required_scan_catches_wrapped_template_claim(self):
        """Red case: the pre-fix two-line template wording must fail the scan."""
        old_wording = (
            "Write short, plain sentences. `pr-lint` requires the title, "
            "the linked issue (feat/fix/perf/refactor/security)\n"
            "and Verification; the other sections are optional context for the reviewer."
        )
        with self.assertRaises(AssertionError):
            assert_no_bare_required_claim(old_wording, "template")
        with self.assertRaises(AssertionError):
            assert_no_bare_required_claim(old_wording.replace("\n", " "), "template")

    def test_required_scan_catches_contributing_list_claim(self):
        """Red case: the pre-PR CONTRIBUTING bullet must fail even next to a warns bullet."""
        old_bullet = (
            "- `pr-lint` requires Linked Issues or Issue Description and\n"
            "Verification (commands run and their results); the other sections are optional.\n"
            "- Keep references public-safe. `pr-lint` warns when it finds a card ID in the title.\n"
        )
        with self.assertRaises(AssertionError):
            assert_no_bare_required_claim(old_bullet, "CONTRIBUTING.md")

    def test_template_states_warn_mode(self):
        """The PR template is read first, so it must carry the same warn-mode contract as CONTRIBUTING.md."""
        text = TEMPLATE.read_text(encoding="utf-8")
        low = text.lower()
        self.assertIn("pr_standards_mode", low, "template must name the PR_STANDARDS_MODE knob")
        self.assertIn("warn", low, "template must state the current warn mode")
        self.assertIn('"error"', text, 'template must state the flip to "error"')
        self.assertIn("title", low, "template must note the title always fails")
        self.assertIn("empty body", low, "template must note an empty body always fails")

    def test_template_carries_attestation_section(self):
        """The template must offer the org Attestation section and keep its field syntax."""
        text = TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("\n## Attestation\n", text, "template must carry the Attestation heading")
        att = text.split("\n## Attestation\n", 1)[1]
        self.assertRegex(att, r"(?m)^risk_tier: <T0\|T1\|T2>$")
        self.assertRegex(att, r"(?m)^### Claims$")
        self.assertRegex(att, r"(?m)^- C1: ")
        self.assertRegex(att, r"(?m)^### Tests$")
        self.assertRegex(att, r"(?m)^- C1 \| test=.+ \| failed_before=not-run \| proof=")
        self.assertRegex(att, r"(?m)^### High-risk checklist$")
        for n in range(1, 9):
            self.assertRegex(att, rf"(?m)^- \[ \] D{n}: ", f"checklist must keep D{n}")

    def test_template_does_not_call_attestation_optional(self):
        """The opening guidance must name Attestation so it is not read as an optional section."""
        opening = TEMPLATE.read_text(encoding="utf-8").split("-->", 1)[0]
        self.assertIn("attestation", opening.lower())


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
        self.assertTrue(check_pr_quiet("not conventional", GOOD_BODY, "alice", (), "warning"))
        self.assertTrue(
            check_pr_quiet(
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

    def test_strict_title_body_hits_fail_in_warn_mode(self):
        """The strict subset (tracker id, instance link, internal host) fails even in warn mode."""
        mode = workflow_env("PR_STANDARDS_MODE")
        self.assertEqual(mode, "warn", "test expectation pins the current warn mode; update docs + test on flip")
        strict_body = GOOD_BODY.replace("Fixes #123", "Refs: TOG-1234")
        findings = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refresh the key",
                "BODY": strict_body,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(
            any(f.level == "error" and f.title == "Internal reference" for f in findings),
            findings,
        )
        strict_title = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): handle TOG-1234 retries",
                "BODY": GOOD_BODY,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(
            any(f.level == "error" and f.title == "Internal reference" for f in strict_title),
            strict_title,
        )
        # The advisory remainder still only warns: a localhost URL is not strict.
        advisory_body = GOOD_BODY + "\nProbed at http://localhost:8787/health.\n"
        advisory = ps.evaluate(
            {
                "EVENT": "pull_request",
                "TITLE": "fix(auth): refresh the key",
                "BODY": advisory_body,
                "AUTHOR": "alice",
                "HEAD_REF": "fix/short-slug",
                "REPO_PRIVATE": "false",
                "PR_STANDARDS_MODE": mode,
            }
        )
        self.assertTrue(
            any(f.level == "warning" and f.title == "Internal reference" for f in advisory),
            advisory,
        )
        self.assertFalse(any(f.level == "error" for f in advisory), advisory)

    def test_commit_subject_ids_warn_in_configured_mode(self):
        level = workflow_env("INTERNAL_ID_LEVEL")
        self.assertEqual(level, "warning", "test expectation pins the current warning level; update docs + test on flip")
        self.assertFalse(
            check_pr_quiet(
                "fix(ci): handle TOG-1234 retries", GOOD_BODY, "alice", (), level
            )
        )
        self.assertTrue(
            check_pr_quiet(
                "fix(ci): handle TOG-1234 retries", GOOD_BODY, "alice", (), "error"
            )
        )

    def test_convention_calls_emit_no_workflow_commands(self):
        """Red case: check_pr prints ::error/::warning, so callers must swallow it."""
        noisy = [
            ("not conventional", GOOD_BODY, "alice", (), "warning"),
            ("fix(auth): refuse expired sudo sessions", "<!-- nothing -->  ", "alice", (), "warning"),
            ("fix(ci): handle TOG-1234 retries", GOOD_BODY, "alice", (), "warning"),
            ("fix(ci): handle TOG-1234 retries", GOOD_BODY, "alice", (), "error"),
        ]
        # The raw checker leaks workflow commands (proves the trap is real).
        loud = io.StringIO()
        with contextlib.redirect_stdout(loud):
            for args in noisy:
                _conventions.check_pr(*args)
        self.assertTrue(
            any(line.startswith("::") for line in loud.getvalue().splitlines()),
            "expected check_pr to print :: workflow commands",
        )
        # The quiet helper used above must not.
        quiet = io.StringIO()
        with contextlib.redirect_stdout(quiet):
            for args in noisy:
                check_pr_quiet(*args)
        leaked = [line for line in quiet.getvalue().splitlines() if line.startswith("::")]
        self.assertEqual([], leaked)

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
        job = text.split("  pr-lint:\n", 1)[1].split("  gitleaks:\n", 1)[0]
        step = job.split("      - name: Unit-test the lint\n", 1)[1].split("      - name:", 1)[0]
        # Guarded run so stale heads predating the file skip instead of
        # exiting 5 with NO TESTS RAN, and deletion heads fail closed.
        self.assertIn("[ -f ci/test_pr_lint_docs.py ]", step)
        self.assertIn("python3 -m unittest discover -s ci -p 'test_pr_lint_docs.py'", step)
        self.assertIn("git log --format=%H -1 HEAD -- ci/test_pr_lint_docs.py", step)
        self.assertIn("refusing to skip", step)
        self.assertIn("predates #769", step)
        self.assertNotIn("continue-on-error", step)
        self.assertNotIn("if:", step)


if __name__ == "__main__":
    unittest.main()
