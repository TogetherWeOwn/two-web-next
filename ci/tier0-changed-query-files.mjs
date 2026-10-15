import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Tier-0 changed query files\n");

const result = spawnSync(
  "git",
  [
    "diff",
    "--name-only",
    "origin/main...HEAD",
    "--",
    "src/db",
    "src/events",
    "src/join",
    "src/profiles",
    "src/admin",
    "src/sessions.ts",
  ],
  { encoding: "utf8" },
);

if (result.status === 0) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.stdout);
} else {
  console.log("::warning::changed query files unavailable");
}
