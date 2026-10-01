"""Offline regression tests for the real PR convention checker.

Run with: python3 -m unittest discover -s ci -p 'test_check_pr_conventions.py'
"""

import json
from pathlib import Path
import subprocess
import sys
import unittest


CHECKER = Path(__file__).with_name("check-pr-conventions.py")
TITLE = "fix(ci): require visible card references"
BODY = "Explain the focused checker change and its offline regression tests."


class PrConventionsTests(unittest.TestCase):
    def run_checker(self, expected_code=0, **inputs):
        env = {
            "EVENT": "pull_request",
            "TITLE": TITLE,
            "BODY": BODY + "\n\nRefs: TOG-1234",
            "AUTHOR": "contributor",
            "REQUIRE_CARD_REF": "true",
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

    def test_visible_standalone_reference(self):
        for ref in ("Refs: TOG-1234", "\tRefs: TOG-1234  ", "Refs:\tTOG-1234"):
            with self.subTest(ref=ref):
                self.run_checker(BODY=BODY + "\n\n" + ref + "\n")

    def test_crlf_reference(self):
        self.run_checker(BODY=BODY + "\r\n\r\nRefs: TOG-1234\r\n")

    def test_hidden_references_fail(self):
        for comment in (
            "<!-- Refs: TOG-1234 -->",
            "<!--\nRefs: TOG-1234\n-->",
            "<!-- first -->\n<!--\nRefs: TOG-1234\nlast -->",
        ):
            with self.subTest(comment=comment):
                output = self.run_checker(1, BODY=BODY + "\n" + comment)
                self.assertIn("::error title=Card reference::", output)
                self.assertNotIn("::error title=PR body::", output)

    def test_incidental_and_malformed_references_fail(self):
        for ref in (
            "Related to TOG-1234.",
            "This fixes Refs: TOG-1234",
            "Refs: TOG-1234 is relevant.",
            "Refs: TOG-1234suffix",
            "Refs: TOG-",
            "Refs: TOG-abc",
            "refs: TOG-1234",
            "Refs: OTHER-1234",
            "",
        ):
            with self.subTest(ref=ref):
                output = self.run_checker(1, BODY=BODY + "\n" + ref)
                self.assertIn("::error title=Card reference::", output)

    def test_hidden_reference_does_not_hide_visible_reference(self):
        self.run_checker(BODY=BODY + "\n<!-- Refs: TOG-9999 -->\nRefs: TOG-1234")

    def test_optional_reference_mode(self):
        for body in (BODY, BODY + "\n<!-- Refs: TOG-1234 -->"):
            with self.subTest(body=body):
                self.run_checker(BODY=body, REQUIRE_CARD_REF="false")
        output = self.run_checker(1, BODY="short", REQUIRE_CARD_REF="false")
        self.assertIn("::error title=PR body::", output)
        self.assertNotIn("::error title=Card reference::", output)

    def test_reference_required_by_default(self):
        output = self.run_checker(1, BODY=BODY, REQUIRE_CARD_REF=None)
        self.assertIn("::error title=Card reference::", output)

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
                # The visible reference contributes 13 non-whitespace characters.
                body = "x" * (length - 13) + "\nRefs: TOG-1234"
                output = self.run_checker(expected, BODY=body)
                if expected:
                    self.assertIn("::error title=PR body::", output)
        output = self.run_checker(
            1, BODY="<!-- " + "x" * 80 + " -->\nRefs: TOG-1234"
        )
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

    def test_dispatch_uses_same_reference_gate(self):
        self.run_checker(EVENT="workflow_dispatch")
        output = self.run_checker(
            1, EVENT="workflow_dispatch", BODY=BODY + "\n<!-- Refs: TOG-1234 -->"
        )
        self.assertIn("::error title=Card reference::", output)

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
        for message in ("Update checker", "fix(ci): trailing period.", "fix(ci): " + "x" * 92, ""):
            with self.subTest(message=message):
                output = self.run_checker(
                    1, EVENT="push", COMMITS=json.dumps([{"id": "a" * 40, "message": message}])
                )
                self.assertIn("::error title=Commit on main::", output)


if __name__ == "__main__":
    unittest.main()
