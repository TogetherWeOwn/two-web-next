"""Offline regression tests for the real PR convention checker.

Run with: python3 -m unittest discover -s ci -p 'test_check_pr_conventions.py'
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CHECKER = Path(__file__).with_name("check-pr-conventions.py")
TITLE = "fix(ci): stop requiring card references"
BODY = "Explain the focused checker change and its offline regression tests."


class PrConventionsTests(unittest.TestCase):
    def run_checker(self, expected_code=0, **inputs):
        env = {
            "EVENT": "pull_request",
            "TITLE": TITLE,
            "BODY": BODY,
            "AUTHOR": "contributor",
        }
        env.update(inputs)
        env = {key: value for key, value in env.items() if value is not None}
        result = subprocess.run(
            [sys.executable, str(CHECKER)],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, expected_code, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        if expected_code == 0:
            self.assertIn("PR conventions OK", result.stdout)
        else:
            self.assertNotIn("PR conventions OK", result.stdout)
        return result.stdout

    def test_no_card_reference_is_required(self):
        for event in ("pull_request", "workflow_dispatch"):
            with self.subTest(event=event):
                output = self.run_checker(EVENT=event, BODY=BODY)
                self.assertNotIn("::error", output)
                self.assertNotIn("::warning", output)

    def test_card_reference_requirement_is_gone(self):
        # The old switch must not bring the requirement back.
        output = self.run_checker(BODY=BODY, REQUIRE_CARD_REF="true")
        self.assertNotIn("Card reference", output)

    def test_internal_id_in_title_warns(self):
        output = self.run_checker(TITLE="fix(ci): handle TOG-1234 retries")
        self.assertIn("::warning title=Internal ID::", output)
        self.assertIn("the PR title", output)
        self.assertNotIn("::error", output)

    def test_internal_id_in_body_warns(self):
        for ref in ("Refs: TOG-1234", "Closes PAP-77.", "see (TOG-9)", "PAP-1\r\nTOG-2"):
            with self.subTest(ref=ref):
                output = self.run_checker(BODY=BODY + "\n\n" + ref)
                self.assertIn("::warning title=Internal ID::", output)
                self.assertIn("the PR body", output)
                self.assertNotIn("::error", output)

    def test_internal_id_in_html_comment_still_warns(self):
        output = self.run_checker(BODY=BODY + "\n<!-- Refs: TOG-1234 -->")
        self.assertIn("::warning title=Internal ID::", output)

    def test_warning_names_places_without_echoing_the_id(self):
        output = self.run_checker(
            TITLE="fix(ci): handle TOG-1234 retries", BODY=BODY + "\nPAP-5678"
        )
        self.assertIn("the PR title, the PR body", output)
        self.assertNotIn("1234 retries", output)
        self.assertNotIn("PAP-5678", output)

    def test_template_prefix_text_without_digits_does_not_warn(self):
        body = BODY + "\n- [ ] No internal card ID (TOG-, PAP-) is in the title.\nTOGETHER-1 PAPER-2 STOG-3"
        output = self.run_checker(BODY=body)
        self.assertNotIn("::warning", output)

    def test_internal_id_in_commit_subjects_warns(self):
        with tempfile.TemporaryDirectory() as scratch:
            listing = Path(scratch) / "subjects.txt"
            listing.write_text("feat(ci): clean subject\nfix(ci): handle TOG-42\n", encoding="utf-8")
            output = self.run_checker(COMMIT_SUBJECTS_PATH=str(listing))
            self.assertIn("::warning title=Internal ID::", output)
            self.assertIn("commit subject 2", output)
            self.assertNotIn("commit subject 1", output)
            clean = Path(scratch) / "clean.txt"
            clean.write_text("feat(ci): clean subject\n", encoding="utf-8")
            self.assertNotIn("::warning", self.run_checker(COMMIT_SUBJECTS_PATH=str(clean)))

    def test_missing_commit_subject_listing_is_ignored(self):
        output = self.run_checker(COMMIT_SUBJECTS_PATH="/nonexistent/subjects.txt")
        self.assertNotIn("::warning", output)

    def test_error_level_fails_on_internal_ids(self):
        for level in ("error", "bogus", ""):
            with self.subTest(level=level):
                output = self.run_checker(
                    1, BODY=BODY + "\nRefs: TOG-1234", INTERNAL_ID_LEVEL=level
                )
                self.assertIn("::error title=Internal ID::", output)
        self.run_checker(BODY=BODY + "\nRefs: TOG-1234", INTERNAL_ID_LEVEL="warning")
        self.run_checker(BODY=BODY, INTERNAL_ID_LEVEL="error")

    def test_internal_id_check_does_not_replace_convention_errors(self):
        output = self.run_checker(1, TITLE="Update TOG-1 checker", BODY=BODY)
        self.assertIn("not a Conventional Commits header", output)
        self.assertIn("::warning title=Internal ID::", output)

    def test_valid_conventional_titles(self):
        for title in (
            "feat: add checker coverage",
            "fix(ci): require visible references",
            "security(ci)!: reject hidden references",
            "fix(ci): " + "x" * 91,
        ):
            with self.subTest(title=title):
                self.run_checker(TITLE=title)

    def test_invalid_title_controls(self):
        for title, error in (
            ("Update checker", "not a Conventional Commits header"),
            ("unknown(ci): change checker", "not a Conventional Commits header"),
            ("fix(ci): " + "x" * 92, "101 chars (max 100)"),
            ("fix(ci): require visible references.", "ends with a period"),
        ):
            with self.subTest(title=title):
                output = self.run_checker(1, TITLE=title)
                self.assertIn(error, output)

    def test_body_length_boundary_and_comment_stripping(self):
        for length, expected in ((39, 1), (40, 0)):
            with self.subTest(length=length):
                output = self.run_checker(expected, BODY="x" * length)
                if expected:
                    self.assertIn("::error title=PR body::", output)
        output = self.run_checker(1, BODY="<!-- " + "x" * 80 + " -->")
        self.assertIn("::error title=PR body::", output)

    def test_dependency_bot_exemptions(self):
        for author in ("dependabot[bot]", "renovate[bot]"):
            with self.subTest(author=author):
                output = self.run_checker(AUTHOR=author, TITLE="Update dependency", BODY="")
                self.assertIn("::warning::", output)
                self.assertNotIn("::error", output)
                self.run_checker(AUTHOR=author, TITLE="chore(deps): update package", BODY="")
        for author in ("dependabot", "renovate", "other[bot]"):
            with self.subTest(author=author):
                self.run_checker(1, AUTHOR=author, BODY="")

    def test_dispatch_uses_same_body_gate(self):
        self.run_checker(EVENT="workflow_dispatch")
        output = self.run_checker(1, EVENT="workflow_dispatch", BODY="short")
        self.assertIn("::error title=PR body::", output)

    def test_push_controls(self):
        self.run_checker(EVENT="push", COMMITS="[]", TITLE="invalid", BODY="")
        for message in (
            "fix(ci): require visible references\n\nDetails without a card reference",
            "Merge branch 'main'",
            'Revert "an old commit"',
        ):
            with self.subTest(message=message):
                self.run_checker(
                    EVENT="push", COMMITS=json.dumps([{"id": "a" * 40, "message": message}])
                )
        output = self.run_checker(
            EVENT="push",
            COMMITS=json.dumps([{"id": "a" * 40, "message": "fix(ci): handle TOG-42\n\nbody"}]),
        )
        self.assertIn("::warning title=Internal ID::", output)
        self.assertIn("commit subject 1", output)
        self.run_checker(
            1,
            EVENT="push",
            INTERNAL_ID_LEVEL="error",
            COMMITS=json.dumps([{"id": "a" * 40, "message": "fix(ci): handle PAP-42"}]),
        )
        for message in ("Update checker", "fix(ci): trailing period.", "fix(ci): " + "x" * 92, ""):
            with self.subTest(message=message):
                output = self.run_checker(
                    1, EVENT="push", COMMITS=json.dumps([{"id": "a" * 40, "message": message}])
                )
                self.assertIn("::error title=Commit on main::", output)


if __name__ == "__main__":
    unittest.main()
