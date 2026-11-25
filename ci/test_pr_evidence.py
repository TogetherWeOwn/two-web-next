from copy import deepcopy
from functools import partial
import json
from pathlib import Path
import unittest

from pr_evidence import BOT, MARKER, pages, publish, route

FIXTURES = json.loads(Path(__file__).with_name("fixtures").joinpath("pr-evidence-metadata.json").read_text())
HEAD, NEXT = FIXTURES["pull"]["head"]["sha"], "b" * 40


def completion(action="completed", **run):
    return {"action": action, "workflow_run": FIXTURES["run"] | {"pull_requests": []} | run}


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.pr = deepcopy(FIXTURES["pull"])
        self.comments, self.timeline, self.runs, self.jobs, self.siblings = [], [], [], [], []
        self.destinations, self.writes = [self.pr], []
        self.reads = self.move_on_read = 0
        self.publish = partial(publish, self.api, self.pr["base"]["repo"]["full_name"], 42)

    def run_record(self, run_id, **changes):
        return FIXTURES["run"] | dict(id=run_id, run_number=run_id, pull_requests=[self.pr]) | changes

    def records(self, **changes):
        run = self.run_record(101, **changes)
        job = FIXTURES["job"] | dict(head_sha=run["head_sha"], run_attempt=run["run_attempt"],
                                     conclusion=run["conclusion"])
        self.runs, self.jobs = [self.run_record(100, path=run["path"]), run], [job]

    def api(self, method, path, data=None, *, paginate=False):
        if method != "GET":
            self.assertIn((method, path), (("POST", "/issues/42/comments"), ("PATCH", "/issues/comments/123")))
            self.writes.append(method)
            if method == "POST":
                self.comments.append(dict(id=123, user=BOT))
            target = next(c for c in self.comments if c["id"] == 123)
            target.update(data)
            return target
        if path == "/pulls/42":
            self.reads += 1
            if self.reads == self.move_on_read:
                self.pr["head"]["sha"] = NEXT
            return deepcopy(self.pr)
        self.assertTrue(paginate)
        if path.startswith("/commits/"):
            self.assertRegex(path, rf"^/commits/({HEAD}|{NEXT})/pulls\?per_page=100$")
            return [self.destinations]
        if path.startswith("/issues/42/"):
            return [self.comments if "comments?" in path else self.timeline]
        if path == "/pulls?state=all&head=contributor%3Atopic&per_page=100":
            return [[self.pr, *self.siblings]]
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
        self.assertEqual((len(self.comments), self.pr["body"], self.comments[-1]["id"]), (2, FIXTURES["pull"]["body"], 123))

    def test_superseded_incomplete_failed_and_skipped(self):
        for case in FIXTURES["run_cases"]:
            self.records(**case["run"])
            self.jobs = self.jobs if case["jobs"] else []
            row = next(line for line in self.publish().splitlines() if line.startswith("| ci-ok"))
            self.assertRegex(row, case["row"])
        for source, gate, witness in (("ci", "ci-ok", "static-check"), ("e2e", "e2e-ok", "browser-smoke")):
            for case in FIXTURES["readiness_cases"]:
                self.records(path=f".github/workflows/{source}.yml")
                self.jobs[0]["name"] = gate
                self.timeline = [dict(event="ready_for_review", created_at=case["ready"])]
                if case["witness"]:
                    self.jobs.append(self.jobs[0] | dict(id=901, name=witness, conclusion=case["witness"]))
                self.assertIn(f'| {case["evidence"]} |', self.publish())

    def test_retarget_and_closed_sibling_history(self):
        self.records()
        for case in FIXTURES["history_cases"]:
            self.timeline, self.siblings = case.get("timeline", []), case.get("siblings", [])
            self.assertIn(f'| {case["evidence"]} |', self.publish(), case["name"])

    def test_corrupt_pages_and_head_movement_fail_closed(self):
        self.assertRaisesRegex(ValueError, "count limit", pages, lambda *args, **kwargs: [[{}] * 100] * 10, "/pulls")
        self.runs = [self.run_record(1)] * 101
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.publish()
        self.assertIn("Evidence unavailable", self.comments[0]["body"])
        self.reads, self.move_on_read, self.runs = 0, 2, []
        self.assertIsNone(self.publish())
        self.assertNotIn(NEXT, self.comments[0]["body"])

    def test_completion_routes_only_to_open_exact_head_prs(self):
        head = self.pr["head"]
        self.destinations += [self.pr, self.pr | {"number": 43, "state": "closed"},
                              self.pr | {"number": 44, "head": head | {"sha": NEXT}},
                              self.pr | {"number": 45, "head": head | {"repo": {"id": 3}}},
                              self.pr | {"number": 46, "base": {"ref": "other"}}]
        self.assertEqual(route(self.api, {"number": 42}), [42])
        self.assertEqual(route(self.api, completion()), [42])
        self.assertEqual(route(self.api, completion(event="pull_request_review")), [42])
        with self.assertRaisesRegex(ValueError, "Invalid workflow run head"):
            route(self.api, completion(head_sha="bad"))

    def test_ignored_events_and_direct_fallback_need_no_commit_lookup(self):
        def no_lookup(*args, **kwargs):
            self.fail("unexpected API call")

        self.assertEqual(route(no_lookup, {"number": 42}), [42])
        for event in (completion("requested", status="requested"),
                      completion("in_progress", status="in_progress"), completion(status="in_progress"),
                      completion(event="push"), completion(event="workflow_dispatch"),
                      completion(head_repository=None)):
            with self.subTest(event=event):
                self.assertEqual(route(no_lookup, event), [])

    def test_direct_then_completions_refresh_final_attempt_without_duplicate_writes(self):
        self.records(run_attempt=2, status="in_progress")
        self.assertEqual(route(self.api, {"number": 42}), [42])
        self.assertIn("| pending |", self.publish())

        self.records(run_attempt=2)
        # Deliver the final completion first, then lagging completions and a PR edit.
        events = [completion(run_attempt=2), completion(id=100, conclusion="cancelled"),
                  completion(event="pull_request_review"), {"number": 42, "action": "edited"}]
        for event in events:
            self.assertEqual(route(self.api, event), [42])
            self.assertRegex(self.publish(), r"\| ci-ok \| \[success\].*runs/101/attempts/2\).*\| success \|")
        self.assertEqual(self.writes, ["POST", "PATCH"])

    def test_queued_stale_route_and_same_sha_fork_cannot_replace_current_evidence(self):
        queued = route(self.api, completion())
        self.assertEqual(queued, [42])
        self.pr["head"]["sha"] = NEXT
        self.records(head_sha=NEXT, run_attempt=2)
        self.assertEqual(route(self.api, {"number": 42}), [42])
        self.assertIn(NEXT, self.publish())

        other_fork = self.run_record(102, head_sha=NEXT, head_repository={"id": 3}, conclusion="failure")
        self.runs.append(other_fork)
        self.assertEqual(route(self.api, completion()), [])
        self.assertEqual(route(self.api, completion(**other_fork)), [])
        for number in queued:
            self.assertEqual(number, 42)
            self.assertRegex(self.publish(), r"\| ci-ok \| \[success\].*runs/101/attempts/2\).*\| success \|")
        self.assertEqual(self.writes, ["POST"])

    def test_workflow_keeps_refresh_cancellation_separate_from_the_writer_lock(self):
        workflow = Path(__file__).resolve().parents[1] / ".github/workflows/pr-evidence.yml"
        triggers, jobs = workflow.read_text().split("\njobs:\n", 1)
        self.assertRegex(triggers, r"(?m)^  workflow_run:\n    workflows: [^\n]+\n    types: \[completed\]$")
        self.assertIn("\nconcurrency:\n", triggers)
        self.assertIn("format('pr-evidence-direct-{0}', github.event.number)", triggers)
        self.assertIn("format('pr-evidence-completed-{0}-{1}', github.event.workflow_run.head_repository.id, "
                      "github.event.workflow_run.head_sha)", triggers)
        self.assertIn("\n  cancel-in-progress: true\n", triggers)
        publisher = jobs.split("\n  publish:\n", 1)[1]
        self.assertIn("always() && needs.route.result == 'success'", publisher)
        self.assertIn("group: pr-evidence-${{ matrix.number }}\n      cancel-in-progress: false", publisher)
        self.assertIn("ref: ${{ github.workflow_sha }}\n          persist-credentials: false", publisher)
        self.assertIn("always() && steps.trusted-source.outcome == 'success'", publisher)
