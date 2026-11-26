"""Exercise the workflow's actual admission logic with synthetic Actions records."""
from copy import deepcopy
from pathlib import Path
from textwrap import dedent
from unittest import TestCase, main
from unittest.mock import patch

yaml = Path(".github/workflows/pr-ci-admission.yml").read_text()
scope = {"__name__": "admission_fixture"}
exec(dedent(yaml.split("<<'PYTHON'\n")[1].rsplit("          PYTHON", 1)[0]), scope)


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
        ignored = dict(edit[0], id=31, name="pr-gates ignored edit (scan)", conclusion="skipped", runner_id=None)
        edit.append(ignored)
        self.assertEqual(evidence()["gitleaks"], (1, 1, 11))
        scan_yaml = Path(".github/workflows/pr-gates.yml").read_text().split("\n  gitleaks:\n")[1]
        ignored["name"] = scan_yaml.split("name: >-\n")[1].split("\n    needs:")[0].strip()[3:-2].strip()
        self.assertEqual(evidence()["gitleaks"], (1, 1, 11))
        for key, invalid, valid in [("conclusion", "success", "skipped"), ("runner_id", 1, None)]:
            ignored[key] = invalid
            with self.assertRaisesRegex(ValueError, "Invalid advisory job"):
                evidence()
            ignored[key] = valid
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
        runs[2]["conclusion"] = edit[0]["conclusion"] = "cancelled"
        self.assertIsNone(evidence())
        newer = add("pr-gates", "pr-lint")
        newer.append(dict(ignored, id=41, run_id=4))
        self.assertIsNone(evidence(), "a cancelled run's raw scan name cannot establish its scope")
        runs[2]["display_title"] = "pr-gates metadata lint"
        ignored["conclusion"] = "cancelled"
        self.assertEqual(evidence()["pr-lint"], (4, 1, 40))
        self.assertEqual(evidence()["gitleaks"], (1, 2, 12))
        runs[0]["conclusion"] = "cancelled"
        self.assertIsNone(evidence())
        runs[0]["conclusion"] = "success"
        ignored["name"] = "gitleaks"
        self.assertIsNone(evidence())


if __name__ == "__main__":
    main()
