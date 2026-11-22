"""Fixtures for the blocking risk-tier check in pr-lint."""

import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from pr_risk_tier import TIERS, path_tier, validate


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "ci/pr_risk_tier.py"


def attestation(tier):
    return f"## Attestation\n\nrisk_tier: {tier}\n\n### Claims\n\n- C1: Example.\n"


class RiskTier(unittest.TestCase):
    def test_template_path_floors(self):
        for tier, paths in {
            "T0": (
                "src/MIGRATIONS/note.md", "docs/sql/note.rst", "app/db/read.py",
                "app/database/config.py", "tools/drizzle/docs/README.txt", "src/AUTH.rs",
                "src/api_gateway.go", "src/member-erasure.ts", "src/SessionController.php",
                "src/HTTPSession.ts", "src/ingest/guide.rst", "docs/role-play/README.txt",
                ".github/workflows/deploy-next.yml", "crates/cutover/README.txt",
                "web/config/wrangler.production.toml", "web/wrangler-jobs.jsonc", "wrangler.json",
                ".github/README.txt",
            ),
            "T1": (
                "src/authors.py", "src/voices/read.py", "src/roleplay.ts", "src/caféauth.py",
                "src/README.md", "src/auth.txt", "docs/example.txt", "docs/CMakeLists.txt",
                "docs/requirements.txt", "requirements-dev.txt", "constraints.txt",
                "ci/README.txt", "tools/wrangler.js", "crates/other/guide.rst",
            ),
            "T2": ("README.md", "guide.RST", "docs/guides/auth.md", "docs/wrangler.md",
                   "docs/backup.rst", "extras/CoDe_Of_ConDucT.tXt"),
        }.items():
            for path in paths:
                with self.subTest(path=path):
                    self.assertEqual(tier, TIERS[path_tier(path)])

    def test_matching_and_higher_declarations_pass(self):
        for tier, paths in (("T0", ["src/auth.py"]), ("T1", ["ci/check.py"]),
                            ("T2", ["README.md"]), ("T0", ["README.md"])):
            with self.subTest(tier=tier):
                self.assertIn(f"Declared risk tier {tier}", validate(attestation(tier), paths))
        self.assertIn("T1", validate(attestation("T1"), ["README.md"]))
        self.assertIn("T2", validate(attestation("T2"), []))

    def test_completed_template_uses_the_visible_declaration(self):
        template = (ROOT / ".github/pull_request_template.md").read_text(encoding="utf-8")
        body = template.replace("risk_tier: <T0|T1|T2>", "risk_tier: T0")
        self.assertIn("minimum T0", validate(body, [".github/pull_request_template.md"]))

    def test_missing_invalid_and_hidden_declarations_fail(self):
        line = "risk_tier: T1"
        good = attestation("T1")
        for body in (
            "", line, attestation("ordinary"), attestation("t1"), attestation("<T0|T1|T2>"),
            attestation("T1/T2"), attestation("`T1`"), good.replace(line, ""),
            good.replace(line, "<!-- " + line + " -->"), "<!--\n" + good,
            good.replace(line, "```yaml\n" + line + "\n```"), "~~~~markdown\n" + good + "~~~~\n",
            good.replace(line, "    " + line), good.replace(line, "> " + line),
            good.replace(line, line + "\nrisk_tier: T0"), good + good,
            good.replace(line, "") + line,
        ):
            with self.subTest(body=body):
                with self.assertRaisesRegex(ValueError, "exactly one visible"):
                    validate(body, ["README.md"])

    def test_understated_declarations_fail(self):
        for tier, path, minimum in (("T2", "src/index.ts", "T1"),
                                    ("T1", ".github/workflows/ci.yml", "T0"),
                                    ("T2", "src/auth.py", "T0")):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, f"{tier} is below.*{minimum}"):
                    validate(attestation(tier), ["README.md", path])

    def test_older_pr_keeps_its_existing_contract(self):
        workflow = (ROOT / ".github/workflows/pr-gates.yml").read_text(encoding="utf-8")
        cutoff = re.search(r'(?m)^  RISK_TIER_ERROR_FROM_PR: "(\d+)"$', workflow)[1]
        step = workflow.split("      - name: Check declared risk tier\n", 1)[1]
        run = textwrap.dedent(step.split("        run: |\n", 1)[1].split("      - name:", 1)[0])
        # No metadata or checkout is needed to skip an already-open PR.
        result = subprocess.run(["bash", "-c", run], capture_output=True, text=True, env={
            "GITHUB_EVENT_NAME": "pull_request", "PR_NUMBER": str(int(cutoff) - 1),
            "RISK_TIER_ERROR_FROM_PR": cutoff,
        })
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("before the enforcement cutoff", result.stdout)


class ExactChangedPaths(unittest.TestCase):
    def setUp(self):
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.git("init", "-q")
        self.git("config", "user.email", "example@example.com")
        self.git("config", "user.name", "Example")

    def git(self, *args, input_text=None):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True,
                              text=True, input=input_text).stdout.strip()

    def write(self, path):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n", encoding="utf-8")

    def check_tier(self, base, tier):
        metadata = self.repo / "metadata.json"
        metadata.write_text(json.dumps({"body": attestation(tier)}), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPT)], cwd=self.repo, capture_output=True,
                              text=True, env={**os.environ, "PR_METADATA_PATH": str(metadata),
                                              "FLOOR_WAIVER_BASE_SHA": base})

    def test_each_side_of_a_rename_counts(self):
        self.write("src/auth.py")
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        critical = self.git("rev-parse", "HEAD")
        self.git("mv", "src/auth.py", "guide.md")
        self.git("commit", "-qm", "rename out of critical path")
        docs = self.git("rev-parse", "HEAD")
        moved_out = self.check_tier(critical, "T2")
        self.assertEqual(1, moved_out.returncode)
        self.assertIn("T2 is below the changed-path minimum T0", moved_out.stdout)
        (self.repo / "src").mkdir(exist_ok=True)
        self.git("mv", "guide.md", "src/auth.py")
        self.git("commit", "-qm", "rename into critical path")
        moved_in = self.check_tier(docs, "T2")
        self.assertEqual(1, moved_in.returncode)
        self.assertIn("T2 is below the changed-path minimum T0", moved_in.stdout)

    def test_full_diff_ignores_base_only_changes_and_sees_paths_beyond_api_caps(self):
        self.git("commit", "--allow-empty", "-qm", "initial")
        self.git("branch", "topic")
        self.write("src/auth.py")
        self.git("add", ".")
        self.git("commit", "-qm", "base-only critical file")
        base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "topic")
        blob = self.git("hash-object", "-w", "--stdin", input_text="fixture\n")
        records = "".join(f"100644 {blob}\tdocs/{i:04}.md\n" for i in range(3001))
        self.git("update-index", "--index-info", input_text=records)
        self.git("commit", "-qm", "large docs change")
        passing = self.check_tier(base, "T2")
        self.assertEqual(0, passing.returncode, passing.stdout + passing.stderr)
        self.write("z/permissions/check.py")
        self.git("add", "z")
        self.git("commit", "-qm", "add critical path after docs")
        failing = self.check_tier(base, "T2")
        self.assertEqual(1, failing.returncode, failing.stdout + failing.stderr)
        self.assertIn("T2 is below the changed-path minimum T0", failing.stdout)
        self.assertEqual(0, self.check_tier(base, "T0").returncode)


if __name__ == "__main__":
    unittest.main()
