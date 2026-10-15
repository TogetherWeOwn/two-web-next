import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) appendFileSync(summaryPath, "### Tier-0 changed query files\n");

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
  if (summaryPath) appendFileSync(summaryPath, result.stdout);
  else process.stdout.write(result.stdout);
} else {
  const cause =
    result.error?.code ?? (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
  console.log(`::warning::changed query files unavailable (${cause})`);
}
