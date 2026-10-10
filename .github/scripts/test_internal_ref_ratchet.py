#!/usr/bin/env python3
"""Hermetic tracked-tree ratchet proofs; every reference below is synthetic."""
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import internal_ref_ratchet as ratchet
import internal_references as refs
import pr_standards as standards

ID = "TOG-000000"
LINK = "/ZZ/issues/synthetic-fixture"
SCRIPT = Path(__file__).with_name("internal_ref_ratchet.py")


class Ratchet(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("RUNNER_TEMP")
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.command("init", "-q")
        self.base = self.snapshot()

    def command(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              capture_output=True).stdout.decode().strip()

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text if isinstance(text, bytes) else text.encode())

    def snapshot(self):
        self.command("add", "--all")
        return self.command("write-tree")

    def result(self, base=None, head=None):
        output = io.StringIO()
        with redirect_stdout(output):
            code = ratchet.check(self.repo, self.base if base is None else base,
                                 self.snapshot() if head is None else head)
        return code, output.getvalue()

    def test_added_reference_fails_without_echoing_content(self):
        self.write("docs/example.md", f"Synthetic {ID} and {LINK}\n")
        code, output = self.result()
        self.assertEqual(1, code)
        self.assertEqual('"docs/example.md"\tbase=0\thead=2\n', output)
        self.assertNotIn(ID, output)
        self.assertNotIn(LINK, output)

    def test_moved_reference_passes(self):
        self.write("old.md", ID)
        self.base = self.snapshot()
        (self.repo / "old.md").rename(self.repo / "new.md")
        self.assertEqual(0, self.result()[0])

    def test_split_refactor_passes(self):
        self.write("old.md", f"{ID}\n{LINK}")
        self.base = self.snapshot()
        (self.repo / "old.md").unlink()
        self.write("first.md", ID)
        self.write("second.md", LINK)
        self.assertEqual(0, self.result()[0])

    def test_removed_reference_passes(self):
        self.write("docs/example.md", ID)
        self.base = self.snapshot()
        self.write("docs/example.md", "Public explanation")
        self.assertEqual(0, self.result()[0])

    def test_total_not_per_file_or_per_category(self):
        self.write("a.md", f"{ID}\n{ID}")
        self.base = self.snapshot()
        self.write("a.md", LINK)
        self.write("b.md", LINK)
        self.assertEqual(0, self.result()[0])
        self.write("b.md", f"{LINK}\n{LINK}")
        self.assertEqual(1, self.result()[0])

    def test_fixture_exclusions_are_exact_and_reasoned(self):
        self.assertEqual(3, len(ratchet.LINT_FIXTURE_EXCLUSIONS))
        for name, reason in ratchet.LINT_FIXTURE_EXCLUSIONS.items():
            self.assertTrue(reason.strip())
            self.assertNotIn("*", name)
            self.write(name, f"{ID}\n{LINK}")
        self.assertEqual(0, self.result()[0])
        self.write("elsewhere/test_pr_standards.py", ID)
        self.assertEqual(1, self.result()[0])

    def test_existing_fixture_content_cannot_bank_credit(self):
        fixture = next(iter(ratchet.LINT_FIXTURE_EXCLUSIONS))
        self.write(fixture, f"{ID}\n{ID}")
        self.base = self.snapshot()
        self.write(fixture, "")
        self.write("docs/example.md", ID)
        self.assertEqual(1, self.result()[0])

    def test_comments_and_binary_content_count(self):
        self.write("docs/comment.md", f"<!-- synthetic {ID} -->")
        self.write("opaque.bin", b"\xff\0" + ID.encode() + b"\0")
        self.assertEqual(1, self.result()[0])
        self.assertEqual({"docs/comment.md": 1, "opaque.bin": 1},
                         ratchet.tree_counts(self.repo, self.snapshot()))

    def test_symlink_target_is_counted_without_following_it(self):
        (self.repo / "pointer").symlink_to(ID)
        self.assertEqual(1, self.result()[0])

    def test_untracked_and_uncommitted_edits_do_not_change_pinned_head(self):
        self.write("doc.md", "Clean public explanation")
        head = self.snapshot()
        self.write("doc.md", ID)
        self.write("untracked.md", LINK)
        self.assertEqual(0, self.result(head=head)[0])

    def test_missing_or_invalid_base_fails_closed_without_echo(self):
        for base in ("", "f" * 40, ID, "--help"):
            with self.subTest(base=base):
                code, output = self.result(base=base)
                self.assertEqual(1, code)
                self.assertEqual("Cannot read the base tracked tree; refusing to pass.\n", output)

    def test_missing_head_fails_closed(self):
        self.assertEqual(1, self.result(head="f" * 40)[0])

    def test_unreadable_blob_fails_closed(self):
        self.write("doc.md", ID)
        base = self.snapshot()
        real_git = ratchet.git

        def unreadable(repo, *args, **kwargs):
            if args[0] == "cat-file":
                raise ratchet.UnreadableTree()
            return real_git(repo, *args, **kwargs)

        with patch.object(ratchet, "git", side_effect=unreadable):
            self.assertEqual(1, self.result(base=base, head=base)[0])

    def test_missing_or_truncated_batch_fails_closed(self):
        self.write("doc.md", ID)
        tree = self.snapshot()
        real_git = ratchet.git
        for response in (b"", b"missing\n", b"a blob 100\nshort\n"):
            def broken(repo, *args, **kwargs):
                return response if args[0] == "cat-file" else real_git(repo, *args, **kwargs)
            with self.subTest(response=response), patch.object(ratchet, "git", side_effect=broken):
                self.assertEqual(1, self.result(base=tree, head=tree)[0])

    def test_submodule_cannot_be_silently_skipped(self):
        commit = subprocess.run(
            ["git", "-C", str(self.repo), "-c", "user.name=Synthetic Fixture",
             "-c", "user.email=fixture@example.invalid", "commit-tree", self.base],
            input=b"Synthetic fixture\n", capture_output=True, check=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "Synthetic Fixture", "GIT_COMMITTER_NAME": "Synthetic Fixture",
                 "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"},
        ).stdout.decode().strip()
        self.command("update-index", "--add", "--cacheinfo", f"160000,{commit},companion")
        head = self.command("write-tree")
        self.assertEqual(1, self.result(head=head)[0])

    def test_control_characters_in_paths_are_escaped(self):
        name = "docs/line\n::error::fake.md"
        self.write(name, ID)
        code, output = self.result()
        self.assertEqual(1, code)
        self.assertEqual(1, len(output.splitlines()))
        self.assertEqual(name, json.loads(output.split("\t")[0]))

    def test_cli_requires_base_and_checks_trees(self):
        self.write("doc.md", ID)
        head = self.snapshot()
        result = subprocess.run(["python3", str(SCRIPT), "--base", self.base, "--head", head],
                                cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(1, result.returncode)
        self.assertNotIn(ID, result.stdout + result.stderr)
        result = subprocess.run(["python3", str(SCRIPT)], cwd=self.repo, capture_output=True)
        self.assertNotEqual(0, result.returncode)


class SharedPolicy(unittest.TestCase):
    def test_pr_text_uses_the_same_pattern_objects(self):
        self.assertIs(standards.ticket_id_pattern, refs.ticket_id_pattern)
        self.assertIn(refs.INSTANCE_UI, standards.FIXED_INTERNAL)

    def test_prose_boundaries_prefixes_and_all_ui_sections(self):
        for text, count in ((ID, 1), ("PAP-000000 PAPA-000000", 2),
                            ("tog-000000 XTOG-000000 TOG-000000x _TOG-000000_", 0),
                            ("éTOG-000000 TOG-000000界 CVE-2026-000000", 0)):
            self.assertEqual(count, refs.file_reference_count(text), text)
        for section in ("issues", "agents", "projects", "approvals", "runs"):
            text = f"[synthetic](/ZZ/{section}/fixture)"
            self.assertEqual(1, refs.file_reference_count(text))
            self.assertEqual(["an instance UI link"], standards.internal_hits(text, refs.DEFAULT_PREFIXES))
        self.assertEqual(1, refs.file_reference_count("ACME-000000", "ACME"))
        self.assertEqual(0, refs.file_reference_count("ACME-000000"))

    def test_pr_comment_behavior_is_unchanged_but_files_are_raw(self):
        text = f"<!-- synthetic {ID} {LINK} -->"
        self.assertEqual([], standards.internal_hits(text, refs.DEFAULT_PREFIXES))
        self.assertEqual(2, refs.file_reference_count(text))

    def test_workflow_runs_on_all_pr_heads_inside_existing_required_job(self):
        workflow = SCRIPT.parent.parent / "workflows" / "pr-gates.yml"
        job = workflow.read_text().split("  pr-lint:\n", 1)[1].split("  gitleaks:\n", 1)[0]
        step = job.split("      - name: Ratchet tracked internal references\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("if: github.event_name != 'push'", step)
        self.assertIn('BASE_SHA=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq \'.base.sha\')', step)
        self.assertNotIn("draft", step)
        self.assertNotIn("paths", step)
        self.assertNotIn("continue-on-error", step)
        self.assertIn("github.event.pull_request.base.sha", step)
        self.assertIn("env.PR_LINT_CHECKOUT_SHA", step)
        self.assertIn("github.event.pull_request.head.sha", job)
        self.assertIn('internal_ref_ratchet.py --base "$BASE_SHA" --head "$HEAD_SHA"', step)
        self.assertIn("fetch-depth: 0", job)
        self.assertIn("test_internal_ref_ratchet.py", job)


if __name__ == "__main__":
    unittest.main()
