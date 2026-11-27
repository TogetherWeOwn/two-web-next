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
gates = Path(".github/workflows/pr-gates.yml").read_text()
scan_scope = {"__name__": "source_scan_fixture"}
exec(dedent(gates.split("<<'VERIFY_SOURCE'\n")[1].split("          VERIFY_SOURCE", 1)[0]), scan_scope)
source_scan = scan_scope["source_scan"]


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
        pr = {"number": 4, "head": head, "base": {"sha": "b" * 40, "ref": "main", "repo": {"id": 2}},
              "created_at": "2026-01-01T00:00:00Z"}
        runs, jobs = [], {}

        def add(workflow, *names):
            run = len(runs) + 1
            timestamp = f"2026-01-01T00:00:{run:02d}Z"
            runs.append(dict(id=run, run_number=run, run_attempt=1, status="completed",
                             conclusion="success", event="pull_request", pull_requests=[deepcopy(pr)],
                             created_at=timestamp, updated_at=timestamp,
                             path=f".github/workflows/{workflow}.yml", head_sha=head["sha"],
                             head_branch=head["ref"], head_repository=head["repo"]))
            jobs[run] = [dict(id=run * 10 + i, name=name, status="completed", conclusion="success",
                              head_sha=head["sha"], run_id=run, run_attempt=1, html_url="synthetic",
                              started_at=timestamp)
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

    def test_metadata_checks_use_the_latest_source_scan(self):
        pr, runs, add, api = self.actions_fixture()
        merge_sha = "c" * 40
        def steps(ref, number=4):
            return [{"name": name, "conclusion": "success"}
                    for name in ("Scan the full history", f"Scan PR {number} on 2:{ref} at {merge_sha}")]

        source = add("pr-gates", "pr-lint", "gitleaks")[1]
        source["steps"] = steps("main")
        runs[0]["pull_requests"] = []  # GitHub omits associations for some fork runs.
        lint, skipped = add("pr-gates", "pr-lint", "gitleaks")
        lint["labels"] = ["ubuntu-24.04"]
        skipped.update(labels=[], conclusion="skipped", runner_id=None, steps=[])
        runs[-1]["conclusion"] = "cancelled"
        current = add("pr-gates", "pr-lint", "gitleaks")[0]["run_id"]
        pr["base"]["sha"] = "c" * 40
        def lookup(retarget="", sha=merge_sha):
            return source_scan(api, pr, current, retarget, sha)

        self.assertEqual(lookup(), (runs[0]["created_at"], 11, "synthetic"))
        def cancelled_without_jobs(path):
            return {"total_count": 0, "jobs": []} if path.startswith("actions/runs/2/") else api(path)

        self.assertEqual(source_scan(cancelled_without_jobs, pr, current, "", merge_sha), lookup())
        with patch.dict(runs[1], run_attempt=2):
            with self.assertRaisesRegex(ValueError, "latest source run did not finish"):
                source_scan(cancelled_without_jobs, pr, current, "", merge_sha)
        self.assertIsNone(lookup(sha="d" * 40))
        with patch.dict(runs[0], conclusion="cancelled"):
            self.assertIsNone(lookup(runs[1]["created_at"]))
        with patch.dict(source, steps=steps("main")[:1]):
            self.assertIsNone(lookup())

        newer = add("pr-gates", "pr-lint", "gitleaks")[1]
        for reason in ("failure", "skipped", "cancelled", "success"):
            with self.subTest(reason=reason), patch.dict(newer, conclusion=reason, steps=[]):
                with self.assertRaisesRegex(ValueError, "latest source scan did not pass"):
                    lookup()
        with patch.dict(runs[-1], status="queued", conclusion=None):
            self.assertIsNone(lookup())
        for invalid in ({"conclusion": "cancelled"}, {"run_attempt": 2}):
            with patch.dict(runs[-1], invalid), self.assertRaisesRegex(ValueError, "latest source run did not finish"):
                lookup()

        newer["steps"] = steps("main")
        with patch.dict(runs[0], run_attempt=2, updated_at=runs[-1]["created_at"]):
            with self.assertRaisesRegex(ValueError, "An older source run was retried"):
                lookup()
            later = "2026-01-01T00:00:10Z"
            with patch.dict(runs[-1], run_attempt=2), patch.dict(newer, run_attempt=2, started_at=later):
                self.assertEqual(lookup(), (later, 41, "synthetic"))

        pr["base"]["ref"] = "release"
        runs[-1]["pull_requests"] = [deepcopy(pr)]
        self.assertIsNone(lookup())
        retarget = add("pr-gates", "pr-lint", "gitleaks")[1]
        retarget["steps"] = steps("release")
        stamp = runs[-1]["created_at"]
        self.assertEqual(lookup(stamp), (stamp, 51, "synthetic"))
        with patch.dict(retarget, steps=retarget["steps"] + retarget["steps"][1:]):
            self.assertIsNone(lookup(stamp))
        self.assertIsNone(lookup(stamp, sha="d" * 40))
        sibling = add("pr-gates", "pr-lint", "gitleaks")[1]
        runs[-1]["pull_requests"] = []
        sibling["steps"] = steps("release", 5)
        self.assertEqual(lookup(stamp), (stamp, 51, "synthetic"))
        with patch.dict(sibling["steps"][1], name=f"Scan PR 04 on 2:release at {merge_sha}"):
            self.assertIsNone(lookup(stamp))

        live = dict(pr, state="open", merge_commit_sha=merge_sha)
        scan_scope["verify_current"](lambda _: live, pr, merge_sha)
        live["merge_commit_sha"] = "d" * 40
        with self.assertRaisesRegex(ValueError, "merge revision changed"):
            scan_scope["verify_current"](lambda _: live, pr, merge_sha)

        latest_retarget = scan_scope["latest_retarget"]
        self.assertEqual(latest_retarget(lambda _: [], 4), "")
        ignored_events = [{"event": "commented"}] * 100
        change = {"event": "base_ref_changed", "created_at": stamp}
        pages = lambda path: ignored_events if path.endswith("&page=1") else [change]
        self.assertEqual(latest_retarget(pages, 4), stamp)
        with self.assertRaisesRegex(ValueError, "Incomplete PR retarget history"):
            latest_retarget(lambda _: ignored_events, 4)

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
