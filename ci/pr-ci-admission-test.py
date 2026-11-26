"""Exercise the workflow's actual admission logic with synthetic Actions records."""
from copy import deepcopy
from pathlib import Path
from textwrap import dedent
from unittest import TestCase, main

yaml = Path(".github/workflows/pr-ci-admission.yml").read_text()
scope = {"__name__": "admission_fixture"}
exec(dedent(yaml.split("<<'PYTHON'\n")[1].rsplit("          PYTHON", 1)[0]), scope)


class AdmissionTest(TestCase):
    def test_current_jobs_and_refusals(self):
        head = {"sha": "a" * 40, "ref": "topic", "repo": {"id": 1}}
        pr = {"number": 4, "head": head, "base": dict(head, sha="b" * 40, ref="main")}
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
        size["status"] = "completed"
        runs[1]["run_attempt"] = 2
        self.assertIsNone(evidence())
        runs[1].update(run_attempt=1, status="completed", conclusion="success")
        runs[0]["run_attempt"] = 2
        rerun = dict(source[1], id=12, run_attempt=2, status="queued")
        source.append(rerun)
        self.assertIsNone(evidence())
        rerun["status"] = "completed"
        self.assertEqual(evidence()["gitleaks"], (1, 2, 12))
        self.assertIsNone(scope["evidence"](api, dict(pr, base=dict(pr["base"], sha="c" * 40))))
        for job, field, error in [(size, "conclusion", "concluded failure"), (rerun, "head_sha", "identity mismatch")]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, error):
                job[field], before = "failure", job[field]
                try:
                    evidence()
                finally:
                    job[field] = before


if __name__ == "__main__":
    main()
