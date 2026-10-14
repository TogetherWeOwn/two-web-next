"""Tests for the advisory PR-size labeller.

Run with: python3 -m unittest discover -s .github/scripts -p 'test_pr_size.py'
Also wired into the `Unit-test the lint` step in .github/workflows/pr-gates.yml.
"""

import unittest

import pr_size


class Exclusions(unittest.TestCase):
    def test_lockfiles_are_excluded_at_any_depth(self):
        for path in [
            "package-lock.json",
            "web/package-lock.json",
            "Cargo.lock",
            "crates/app/Cargo.lock",
            "pnpm-lock.yaml",
            "go.sum",
            "vendor.lock",
        ]:
            self.assertTrue(pr_size.is_excluded(path), path)

    def test_generated_and_fixtures_are_excluded(self):
        for path in [
            "assets/app.min.js",
            "styles.min.css",
            "bundle.js.map",
            "src/__snapshots__/page.snap",
            "test/page.test.ts.snap",
            "fixtures/users.json",
            "src/fixtures/users.json",
            "pkg/testdata/golden.txt",
            "dist/index.js",
            "web/dist/index.js",
            "vendor/lib.rs",
        ]:
            self.assertTrue(pr_size.is_excluded(path), path)

    def test_source_is_counted(self):
        for path in [
            "src/app.ts",
            "src/fixtures.ts",  # a file named fixtures, not a fixtures tree
            "test/app.test.ts",
            "db/migrations/0042_add_table.sql",
            "Cargo.toml",
            "package.json",
        ]:
            self.assertFalse(pr_size.is_excluded(path), path)

    def test_repo_extra_globs(self):
        extra = ["public/islands/**", "public/styles.css"]
        self.assertTrue(pr_size.is_excluded("public/islands/going.js", extra))
        self.assertTrue(pr_size.is_excluded("public/styles.css", extra))
        self.assertFalse(pr_size.is_excluded("public/theme.css", extra))


class Sizing(unittest.TestCase):
    def test_label_boundaries(self):
        self.assertEqual(pr_size.size_label(0), "size/S")
        self.assertEqual(pr_size.size_label(100), "size/S")
        self.assertEqual(pr_size.size_label(101), "size/M")
        self.assertEqual(pr_size.size_label(400), "size/M")
        self.assertEqual(pr_size.size_label(401), "size/L")
        self.assertEqual(pr_size.size_label(1000), "size/L")
        self.assertEqual(pr_size.size_label(1001), "size/XL")

    def test_count_files_splits_counted_and_excluded(self):
        files = [
            {"filename": "src/app.ts", "additions": 30, "deletions": 10},
            {"filename": "package-lock.json", "additions": 900, "deletions": 0},
            {"filename": "img/logo.png", "additions": 0, "deletions": 0},
        ]
        counted, excluded, counted_files = pr_size.count_files(files)
        self.assertEqual((counted, excluded, counted_files), (40, 900, 2))


class FakeApi:
    """Records the calls label_pr makes; serves canned PR state."""

    def __init__(self, files, labels=(), marker_comment=None):
        self._files = files
        self.labels = list(labels)
        self.marker_comment = marker_comment
        self.calls = []

    def pr_files(self, number):
        return self._files

    def pr_labels(self, number):
        return list(self.labels)

    def ensure_label(self, name):
        self.calls.append(("ensure", name))

    def add_label(self, number, name):
        self.calls.append(("add", name))
        self.labels.append(name)

    def remove_label(self, number, name):
        self.calls.append(("remove", name))
        self.labels.remove(name)

    def find_marker_comment(self, number):
        return self.marker_comment

    def upsert_comment(self, number, body):
        self.calls.append(("comment", body))


def big_files():
    return [{"filename": "src/big.ts", "additions": 500, "deletions": 0}]


class LabelFlow(unittest.TestCase):
    def test_over_threshold_labels_and_comments_once(self):
        api = FakeApi(big_files(), labels=["size/S"])
        label, counted = pr_size.label_pr(api, 7, 400, (), log=lambda *_: None)
        self.assertEqual((label, counted), ("size/L", 500))
        self.assertEqual(api.labels, ["size/L"])
        comments = [body for kind, body in api.calls if kind == "comment"]
        self.assertEqual(len(comments), 1)
        self.assertIn(pr_size.MARKER, comments[0])
        self.assertIn("500 counted lines", comments[0])

    def test_under_threshold_no_comment_without_marker(self):
        api = FakeApi([{"filename": "a.ts", "additions": 5, "deletions": 0}])
        pr_size.label_pr(api, 7, 400, (), log=lambda *_: None)
        self.assertEqual(api.labels, ["size/S"])
        self.assertEqual([c for c in api.calls if c[0] == "comment"], [])

    def test_shrinking_back_updates_existing_comment(self):
        api = FakeApi(
            [{"filename": "a.ts", "additions": 5, "deletions": 0}],
            labels=["size/L"],
            marker_comment={"id": 1, "body": pr_size.MARKER},
        )
        pr_size.label_pr(api, 7, 400, (), log=lambda *_: None)
        comments = [body for kind, body in api.calls if kind == "comment"]
        self.assertEqual(len(comments), 1)
        self.assertIn("back under", comments[0])

    def test_same_label_is_not_readded(self):
        api = FakeApi(big_files(), labels=["size/L"])
        pr_size.label_pr(api, 7, 400, (), log=lambda *_: None)
        self.assertNotIn(("add", "size/L"), api.calls)
        self.assertEqual([c for c in api.calls if c[0] == "remove"], [])


class Weekly(unittest.TestCase):
    def test_tally_counts_each_label_once(self):
        items = [
            {"labels": [{"name": "size/S"}]},
            {"labels": [{"name": "size/L"}, {"name": "bug"}]},
            {"labels": [{"name": "size/XL"}]},
            {"labels": []},
        ]
        counts = pr_size.tally(items)
        self.assertEqual(counts["size/S"], 1)
        self.assertEqual(counts["size/L"], 1)
        self.assertEqual(counts["size/XL"], 1)
        self.assertEqual(counts["size/M"], 0)
        self.assertEqual(counts["unlabelled"], 1)

    def test_report_names_the_total_and_over_threshold(self):
        report = pr_size.weekly_report(
            {"size/S": 2, "size/M": 1, "size/L": 1, "size/XL": 1, "unlabelled": 0},
            "2026-10-07",
        )
        self.assertIn("**5**", report)
        self.assertIn("(2 over the advisory threshold)", report)


if __name__ == "__main__":
    unittest.main()
