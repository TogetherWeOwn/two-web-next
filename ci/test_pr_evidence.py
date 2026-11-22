from copy import deepcopy
import unittest

from pr_evidence import BOT, MARKER, publish

REPO = "TogetherWeOwn/two-web-next"
HEAD, NEXT = "a" * 40, "b" * 40
AUTHOR = "## Verification\n\n- Kept `$(untouched)` from the author\n\n## Attestation\n\nrisk_tier: T1\n"


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        base = {"repo": {"id": 1, "full_name": REPO}, "ref": "main"}
        self.pr = dict(number=42, state="open", draft=False, base=base, body=AUTHOR,
                       head=dict(sha=HEAD, ref="topic", repo={"id": 1}))
        self.comments, self.timeline, self.runs, self.jobs = [], [], [], []
        self.reads = self.move_on_read = 0

    def run_record(self, run_id, **changes):
        return dict(id=run_id, run_number=run_id, run_attempt=1, head_sha=HEAD, head_branch="topic",
                    path=".github/workflows/ci.yml", event="pull_request", head_repository={"id": 1},
                    pull_requests=[self.pr], created_at="2026-11-01T00:00:00Z") | changes

    def records(self, **changes):
        run = self.run_record(101) | dict(status="completed", conclusion="success") | changes
        job = dict(id=900, name="ci-ok", head_sha=HEAD, run_id=101, run_attempt=run["run_attempt"],
                   status="completed", conclusion=run["conclusion"])
        self.runs, self.jobs = [self.run_record(100) | dict(status="completed", conclusion="success"), run], [job]

    def api(self, method, path, data=None, *, paginate=False):
        if method == "POST" and path == "/issues/42/comments":
            self.comments.append(dict(id=123, user=BOT, **data))
            return self.comments[-1]
        if method == "PATCH":
            target = self.pr if path == "/pulls/42" else next(c for c in self.comments if c["id"] == 123)
            target.update(data)
            return target
        self.assertEqual(method, "GET")
        if path == "/pulls/42":
            self.reads += 1
            if self.reads == self.move_on_read:
                self.pr["head"]["sha"] = NEXT
            return deepcopy(self.pr)
        self.assertTrue(paginate)
        if path.startswith("/issues/42/"):
            return [self.comments if "comments?" in path else self.timeline]
        runs = path.startswith(f'/actions/runs?head_sha={self.pr["head"]["sha"]}&')
        if not runs:
            self.assertRegex(path, r"^/actions/runs/101/attempts/[12]/jobs\?")
        key, items = ("workflow_runs", self.runs) if runs else ("jobs", self.jobs)
        return [{"total_count": len(items), key: items[i:i + 100]} for i in range(0, len(items) or 1, 100)]

    def publish(self):
        return publish(self.api, REPO, 42)

    def test_pagination_stable_link_and_new_head(self):
        self.records()
        self.runs[:0] = [self.run_record(i, head_sha=NEXT) for i in range(1, 101) if i != 100] + [
            self.run_record(102, pull_requests=[self.pr | {"number": 43}])]
        self.jobs[:0] = [self.jobs[0] | dict(id=i, name="other") for i in range(1, 101)]
        self.comments.append(dict(id=12, user={}, body=MARKER + "forged"))
        self.assertRegex(self.publish(), r"\| ci-ok \| \[success\].*runs/101/attempts/1\) \| \[success\].*/job/900")
        body = self.pr["body"]
        self.assertTrue(body.endswith(AUTHOR) and "#issuecomment-123)" in body)
        self.pr["head"]["sha"] = NEXT
        self.runs = self.runs[-2:]
        self.assertIn("| ci-ok | missing | missing |", self.publish())
        self.assertIn(NEXT, self.comments[-1]["body"])
        self.assertEqual((len(self.comments), self.pr["body"]), (2, body))

    def test_superseded_incomplete_failed_and_skipped(self):
        for changes, missing, expected in (
            (dict(status="in_progress", run_attempt=2), True, r"\[pending\].*attempts/2\) \| missing \| pending"),
            (dict(conclusion="failure"), False, r"\[failure\].*\| \[failure\]"),
            (dict(run_attempt=2), True, r"attempts/2\) \| missing"),
            (dict(conclusion="skipped"), False, r"\| \[skipped\]"),
        ):
            with self.subTest(changes=changes):
                self.records(**changes)
                if missing:
                    self.jobs = []
                row = next(line for line in self.publish().splitlines() if line.startswith("| ci-ok"))
                self.assertRegex(row, expected)
                self.assertNotIn("runs/100/", row)
                self.assertNotIn("| success |", row)
        self.timeline = [dict(event="ready_for_review", created_at="2026-11-02T00:00:00Z")]
        self.assertIn("[superseded]", self.publish())

    def test_corrupt_pages_and_head_movement_fail_closed(self):
        self.runs = [self.run_record(1)] * 101
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.publish()
        self.assertIn("Evidence unavailable", self.comments[0]["body"])
        self.reads, self.move_on_read, self.runs = 0, 2, []
        self.assertIsNone(self.publish())
        self.assertNotIn(NEXT, self.comments[0]["body"])
        self.assertEqual(self.pr["body"], AUTHOR)
