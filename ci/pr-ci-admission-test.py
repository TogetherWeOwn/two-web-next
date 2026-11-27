"""Exercise the workflow's actual admission logic with synthetic Actions records."""
import re
from copy import deepcopy
from pathlib import Path
from textwrap import dedent
from unittest import TestCase, main
from unittest.mock import patch

yaml = Path(".github/workflows/pr-ci-admission.yml").read_text()
scope = {"__name__": "admission_fixture"}
exec(dedent(yaml.split("<<'PYTHON'\n")[1].rsplit("          PYTHON", 1)[0]), scope)


class AdmissionConcurrencyTest(TestCase):
    def setUp(self):
        match = re.search(
            r"(?m)^jobs:\n  evidence:\n(?:(?!  \S).*\n)*?^    concurrency:\n((?:      .+\n)+)", yaml
        )
        self.assertIsNotNone(match, "jobs.evidence must define concurrency")
        self.concurrency = match[1]

    def test_evidence_group_is_bounded_per_workflow(self):
        match = re.search(r"(?m)^      group: >-\n((?:        .+\n)+)", self.concurrency)
        self.assertIsNotNone(match, "Expected a folded group expression with a lane suffix")
        group = " ".join(match[1].split())
        self.assertNotIn("%", group)

        # Require only the caller name and a literal lane in the group key.
        # Parse just the supported endsWith expression shape to exercise its mapping.
        digit_check = r"endsWith\(format\('\{0\}', github\.event\.pull_request\.number \|\| 0\), '[0-9]'\)"
        clause = rf"\((?:{digit_check} \|\| )*{digit_check}\) && '(?P<lane>[0-2])' \|\| "
        match = re.fullmatch(
            rf"pr-ci-admission-\$\{{\{{ github\.workflow \}}\}}-"
            rf"\$\{{\{{ (?P<clauses>(?:{clause}){{3}})'(?P<fallback>3)' \}}\}}",
            group,
        )
        self.assertIsNotNone(match, "Expected workflow scope, three bounded lane clauses, and lane 3 fallback")
        fallback = match["fallback"]
        routes = {}
        for branch in re.finditer(clause, match["clauses"]):
            for digit in re.findall(r", '([0-9])'\)", branch[0]):
                self.assertNotIn(digit, routes, "A digit may appear in only one lane clause")
                routes[digit] = branch["lane"]

        for first_pr in (10, 3000):
            for offset, lane in enumerate("0001112233"):
                number = first_pr + offset
                with self.subTest(number=number):
                    self.assertEqual(routes.get(str(number)[-1], fallback), lane)
        self.assertEqual(routes.get("0", fallback), "0", "Missing PR numbers use lane 0")

    def test_evidence_queue_preserves_waiting_jobs(self):
        self.assertRegex(self.concurrency, r"(?m)^      cancel-in-progress: false$")
        self.assertRegex(self.concurrency, r"(?m)^      queue: max$")


class AdmissionTest(TestCase):
    def test_queued_admission_allows_main_to_advance(self):
        head = {"sha": "a" * 40, "ref": "topic", "repo": {"id": 1}}
        event = {"number": 4, "head": head, "base": {"sha": "b" * 40, "ref": "main", "repo": {"id": 2}},
                 "state": "open", "draft": False}
        live = deepcopy(event)
        live["base"]["sha"] = "c" * 40

        self.assertEqual(scope["current_identity"](live), scope["current_identity"](event))
        self.assertNotEqual(live["base"]["sha"], event["base"]["sha"])
        scope["verify_current"](lambda path: live, event)

    def test_current_binding_rejects_mismatched_head_or_base_identity(self):
        head = {"sha": "a" * 40, "ref": "topic", "repo": {"id": 1}}
        event = {"number": 4, "head": head, "base": {"sha": "b" * 40, "ref": "main", "repo": {"id": 2}},
                 "state": "open", "draft": False}

        for field, value in (("head", {**head, "sha": "c" * 40}),
                             ("base", {**event["base"], "ref": "release"}),
                             ("base", {**event["base"], "repo": {"id": 3}})):
            with self.subTest(field=field, value=value):
                candidate = deepcopy(event)
                candidate[field] = value
                self.assertNotEqual(scope["current_identity"](candidate), scope["current_identity"](event))
                with self.assertRaisesRegex(ValueError, "head, base, or readiness changed"):
                    scope["verify_current"](lambda path, candidate=candidate: candidate, event)

    def actions_fixture(self):
        head = {"sha": "a" * 40, "ref": "topic", "repo": {"id": 1}}
        pr = {"number": 4, "head": head, "base": {"sha": "b" * 40, "ref": "main", "repo": {"id": 2}}}
        runs, jobs = [], {}

        def add(workflow, *names):
            run = len(runs) + 1
            runs.append(dict(id=run, run_number=run, run_attempt=1, status="completed",
                             conclusion="success", event="pull_request", pull_requests=[deepcopy(pr)],
                             path=f".github/workflows/{workflow}.yml", head_sha=head["sha"],
                             head_branch=head["ref"], head_repository=head["repo"]))
            jobs[run] = [dict(id=run * 10 + i, name=name, status="completed", conclusion="success",
                              head_sha=head["sha"], run_id=run, run_attempt=1, html_url="synthetic")
                         for i, name in enumerate(names)]
            return jobs[run]

        def api(path):
            if path.startswith("actions/workflows/"):
                matches = [run for run in runs if Path(run["path"]).name == path.split("/")[2]]
                return {"total_count": len(matches), "workflow_runs": matches}
            rows = jobs[int(path.split("/")[2])]
            return {"total_count": len(rows), "jobs": rows}

        return pr, runs, add, api

    def test_evidence_allows_main_to_advance_after_runs(self):
        pr, _, add, api = self.actions_fixture()
        add("pr-gates", "pr-lint", "gitleaks")
        add("pr-size", "pr-size-gate / gate")

        pr["base"]["sha"] = "c" * 40
        self.assertEqual(scope["evidence"](api, pr), {
            "pr-lint": (1, 1, 10),
            "gitleaks": (1, 1, 11),
            "pr-size-gate / gate": (2, 1, 20),
        })

    def test_evidence_rejects_mismatched_run_association(self):
        pr, runs, add, api = self.actions_fixture()
        add("pr-gates", "pr-lint", "gitleaks")
        add("pr-size", "pr-size-gate / gate")
        pr["base"]["sha"] = "c" * 40

        for run in runs:
            association = run["pull_requests"][0]
            for path, value in (
                (("number",), 5),
                (("head", "sha"), "d" * 40),
                (("head", "ref"), "other-topic"),
                (("head", "repo", "id"), 3),
                (("base", "ref"), "release"),
                (("base", "repo", "id"), 4),
            ):
                with self.subTest(workflow=run["path"], field=".".join(path)):
                    candidate = deepcopy(association)
                    field = candidate
                    for key in path[:-1]:
                        field = field[key]
                    field[path[-1]] = value
                    with patch.dict(run, pull_requests=[candidate]):
                        self.assertIsNone(scope["evidence"](api, pr))

    def test_current_jobs_and_refusals(self):
        pr, runs, add, api = self.actions_fixture()
        evidence = lambda: scope["evidence"](api, pr)
        source = add("pr-gates", "pr-lint", "gitleaks")
        size = add("pr-size", "pr-size-gate / gate")[0]
        edit = add("pr-gates", "pr-lint")
        self.assertIsNone(evidence())
        ignored = dict(edit[0], id=31, name="pr-gates ignored edit (scan)", conclusion="skipped")
        edit.append(ignored)
        self.assertEqual(evidence()["gitleaks"], (1, 1, 11))
        runs[1].update(status="in_progress", conclusion=None)
        self.assertEqual(evidence()["pr-size-gate / gate"], (2, 1, 20))
        size["status"] = "queued"
        self.assertIsNone(evidence())
        size.update(status="completed", conclusion="failure")
        self.assertIsNone(evidence())
        size["conclusion"] = "success"
        runs[1]["run_attempt"] = 2
        self.assertIsNone(evidence())
        runs[1].update(run_attempt=1, status="completed", conclusion="success")
        runs[0]["run_attempt"] = 2
        rerun = dict(source[1], id=12, run_attempt=2, status="queued")
        source.append(rerun)
        self.assertIsNone(evidence())
        rerun["status"] = "completed"
        self.assertEqual(evidence()["gitleaks"], (1, 2, 12))
        for job, field, error in [(size, "conclusion", "concluded failure"), (rerun, "head_sha", "identity mismatch")]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, error):
                job[field], before = "failure", job[field]
                try:
                    evidence()
                finally:
                    job[field] = before


if __name__ == "__main__":
    main()
