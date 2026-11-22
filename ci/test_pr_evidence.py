from copy import deepcopy
from functools import partial
import unittest

from pr_evidence import BOT, MARKER, publish, route

REPO = "TogetherWeOwn/two-web-next"
HEAD, NEXT = "a" * 40, "b" * 40
AUTHOR = "[Exact-head Actions evidence](#issuecomment-123)\n\n## Attestation\n\nrisk_tier: T1\n"


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        base = {"repo": {"id": 1, "full_name": REPO}, "ref": "main"}
        self.pr = dict(number=42, state="open", draft=False, base=base, body=AUTHOR,
                       head=dict(sha=HEAD, ref="topic", repo={"id": 2}))
        self.comments, self.timeline, self.runs, self.jobs = [], [], [], []
        self.reads = self.move_on_read = 0
        self.publish = partial(publish, self.api, REPO, 42)

    def run_record(self, run_id, **changes):
        return dict(id=run_id, run_number=run_id, run_attempt=1, head_sha=HEAD, head_branch="topic",
                    path=".github/workflows/ci.yml", event="pull_request", head_repository=self.pr["head"]["repo"],
                    pull_requests=[self.pr], created_at="2026-11-01T00:00:00Z",
                    status="completed", conclusion="success") | changes

    def records(self, **changes):
        run = self.run_record(101, **changes)
        job = dict(id=900, name="ci-ok", head_sha=HEAD, run_id=101, run_attempt=run["run_attempt"],
                   status="completed", conclusion=run["conclusion"])
        self.runs, self.jobs = [self.run_record(100, path=run["path"]), run], [job]

    def api(self, method, path, data=None, *, paginate=False):
        if method == "POST" and path == "/issues/42/comments":
            self.comments.append(dict(id=123, user=BOT, **data))
            return self.comments[-1]
        if method == "PATCH":
            self.assertEqual(path, "/issues/comments/123")
            target = next(c for c in self.comments if c["id"] == 123)
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
        key, items, size = ("workflow_runs", self.runs, 73) if runs else ("jobs", self.jobs, 100)
        return [{"total_count": len(items), key: items[i:i + size]} for i in range(0, len(items) or 1, size)]

    def test_pagination_stable_link_and_new_head(self):
        self.records()
        self.runs[:0] = [self.run_record(i, head_sha=NEXT) for i in range(1, 101) if i != 100] + [
            self.run_record(102, pull_requests=[self.pr | {"number": 43}])]
        self.jobs[:0] = [self.jobs[0] | dict(id=i, name="other") for i in range(1, 101)]
        self.comments.append(dict(id=12, user={}, body=MARKER + "forged"))
        self.assertRegex(self.publish(), r"\| ci-ok \| \[success\].*runs/101/attempts/1\) \| \[success\].*/job/900")
        self.pr["head"]["sha"] = NEXT
        self.runs = self.runs[-2:]
        self.assertIn("| ci-ok | missing | missing |", self.publish())
        self.assertIn(NEXT, self.comments[-1]["body"])
        self.assertEqual((len(self.comments), self.pr["body"], self.comments[-1]["id"]), (2, AUTHOR, 123))

    def test_superseded_incomplete_failed_and_skipped(self):
        other_pr = self.pr | {"number": 43, "base": self.pr["base"] | {"ref": "feature"}}
        for changes, missing, expected in (
            (dict(status="in_progress", run_attempt=2), True, r"\[pending\].*attempts/2\) \| missing \| pending \|$"),
            (dict(pull_requests=[]), True, r"\[unbound\].*\| missing \| unbound \|$"),
            (dict(pull_requests=[self.pr, other_pr]), False, r"\[ambiguous\].*\| missing \| ambiguous \|$"),
            (dict(conclusion="failure"), False, r"\[failure\].*\| \[failure\].*\| failure \|$"),
            (dict(run_attempt=2), True, r"attempts/2\) \| missing \| missing \|$"),
            (dict(conclusion="skipped"), False, r"\| \[skipped\].*\| skipped \|$"),
        ):
            self.records(**changes)
            self.jobs = [] if missing else self.jobs
            row = next(line for line in self.publish().splitlines() if line.startswith("| ci-ok"))
            self.assertRegex(row, expected)
        for source, gate, witness in (("ci", "ci-ok", "static-check"), ("e2e", "e2e-ok", "browser-smoke")):
            self.records(path=f".github/workflows/{source}.yml")
            self.jobs[0]["name"] = gate
            self.timeline = [dict(event="ready_for_review", created_at="2026-11-02T00:00:00Z")]
            self.assertIn("| superseded |", self.publish())
            self.timeline[0]["created_at"] = self.runs[-1]["created_at"]
            self.assertIn("| unproven |", self.publish())
            self.jobs.append(self.jobs[0] | dict(id=901, name=witness, conclusion="skipped"))
            self.assertIn("| unproven |", self.publish())
            self.jobs[-1]["conclusion"] = "success"
            self.assertIn("| success |", self.publish())

    def test_corrupt_pages_and_head_movement_fail_closed(self):
        self.runs = [self.run_record(1)] * 101
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.publish()
        self.assertIn("Evidence unavailable", self.comments[0]["body"])
        self.reads, self.move_on_read, self.runs = 0, 2, []
        self.assertIsNone(self.publish())
        self.assertNotIn(NEXT, self.comments[0]["body"])

    def test_completion_routes_only_to_open_exact_head_prs(self):
        def api(method, path, *, paginate):
            self.assertEqual((method, path, paginate), ("GET", f"/commits/{HEAD}/pulls?per_page=100", True))
            return [[self.pr | {"state": "closed"}, self.pr | {"head": {"sha": NEXT}}], [self.pr]]

        self.assertEqual(route(api, {"number": 42}), [42])
        self.assertEqual(route(api, {"workflow_run": {"head_sha": HEAD, "pull_requests": []}}), [42])
        with self.assertRaisesRegex(ValueError, "Invalid workflow run head"):
            route(api, {"workflow_run": {"head_sha": "bad"}})
