"""Synthetic API fixtures for current required PR evidence."""
from copy import deepcopy
from runpy import run_path
from unittest import TestCase, main

evidence = run_path("ci/pr-ci-admission.py")["evidence"]


class EvidenceTest(TestCase):
    def setUp(self):
        self.pr = {"number": 4,
                   "head": {"sha": "a" * 40, "ref": "topic", "repo": {"id": 1}},
                   "base": {"sha": "b" * 40, "ref": "main", "repo": {"id": 1}}}
        self.runs, self.jobs = [], {}
        self.add("pr-gates", "pr-lint", "gitleaks")
        self.add("pr-size", "pr-size-gate / gate")

    def add(self, workflow, *names):
        run = len(self.runs) + 1
        self.runs.append(dict(id=run, run_number=run, run_attempt=1, event="pull_request",
                              path=f".github/workflows/{workflow}.yml", pull_requests=[deepcopy(self.pr)],
                              head_sha=self.pr["head"]["sha"], head_branch="topic", head_repository={"id": 1}))
        self.jobs[run] = [dict(id=run * 10 + i, name=name, status="completed", conclusion="success",
                               head_sha=self.pr["head"]["sha"], run_id=run, run_attempt=1)
                          for i, name in enumerate(names)]
        return self.runs[-1], self.jobs[run]

    def api(self, path):
        if path.startswith("actions/runs?"):
            return {"total_count": len(self.runs), "workflow_runs": self.runs}
        jobs = self.jobs[int(path.split("/")[2])]
        return {"total_count": len(jobs), "jobs": jobs}

    def test_matching_ignored_metadata_scan_reuses_bound_source_success(self):
        _, jobs = self.add("pr-gates", "pr-lint", "pr-gates ignored edit (scan)")
        jobs[1]["conclusion"] = "skipped"
        self.assertEqual(evidence(self.api, self.pr), {
            "pr-lint": (3, 1, 30), "gitleaks": (1, 1, 11), "pr-size-gate / gate": (2, 1, 20),
        })

    def test_missing_scan_and_failing_size_refuse_older_success(self):
        _, jobs = self.add("pr-gates", "pr-lint")
        self.assertIsNone(evidence(self.api, self.pr))
        jobs.append(dict(self.jobs[1][1], run_id=3, id=31))
        _, size = self.add("pr-size", "pr-size-gate / gate")
        size[0].update(conclusion="failure", html_url="synthetic size job")
        with self.assertRaisesRegex(ValueError, "concluded failure"):
            evidence(self.api, self.pr)

    def test_changed_base_or_stale_attempt_does_not_prove_success(self):
        self.pr["base"]["sha"] = "c" * 40
        self.assertIsNone(evidence(self.api, self.pr))
        self.pr["base"]["sha"] = "b" * 40
        self.runs[0]["run_attempt"] = 2
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            evidence(self.api, self.pr)


if __name__ == "__main__":
    main()
