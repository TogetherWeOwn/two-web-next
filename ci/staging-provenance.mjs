// Bind qualification to the deploy title's candidate, never workflow_run.head_sha.
// Live observations are single attempts: a mismatch is adverse evidence, not a retry.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { versionMismatch } from "../bin/version-check.mjs";

const SHA = /^[0-9a-f]{40}$/;
const isSha = (value) => typeof value === "string" && value.length === 40 && SHA.test(value);
const DEPLOY_TITLE = /^deploy ([0-9a-f]{40})$/;

export function resolveStagingCandidate({ eventName, event, sha, ref, repository }) {
  if (eventName === "workflow_dispatch") {
    if (ref !== "refs/heads/main" || !isSha(sha)) {
      throw new Error("Manual staging qualification requires an exact main revision");
    }
    return sha;
  }
  const run = event?.workflow_run;
  const candidate = DEPLOY_TITLE.exec(run?.display_title ?? "")?.[1];
  if (
    eventName !== "workflow_run" ||
    !repository ||
    run?.conclusion !== "success" ||
    run?.head_branch !== "main" ||
    run?.head_repository?.full_name !== repository ||
    !candidate ||
    run.display_title !== `deploy ${candidate}`
  ) {
    throw new Error(
      "Staging qualification requires a successful same-repository main deploy title",
    );
  }
  return candidate;
}

export function validateStagingIdentityPair(expected, before, after, now = Date.now()) {
  if (
    !isSha(expected) ||
    versionMismatch(before, expected, now) ||
    versionMismatch(after, expected, now)
  ) {
    throw new Error("Staging identities do not prove the candidate");
  }
  if (before.deployedAt !== after.deployedAt) {
    throw new Error("Staging deployment changed during qualification");
  }
}

export async function observeStaging({ expected, previous, fetchImpl = fetch, now = Date.now() }) {
  if (!isSha(expected)) throw new Error("Invalid staging candidate");
  const response = await fetchImpl("https://next.togetherweown.com/version", {
    redirect: "error",
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error("Staging identity HTTP response refused");
  const text = await response.text();
  if (text.length > 2048) throw new Error("Staging identity response too large");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Staging identity is not JSON");
  }
  if (versionMismatch(data, expected, now)) {
    throw new Error("Staging identity does not prove the candidate");
  }
  if (previous !== undefined) validateStagingIdentityPair(expected, previous, data, now);
  return { sha: data.sha, deployedAt: data.deployedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, expected, phase, evidence, commitPath, ...extra] = process.argv.slice(2);
    if (command === "candidate" && !expected) {
      const sha = resolveStagingCandidate({
        eventName: process.env.GITHUB_EVENT_NAME,
        event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
        sha: process.env.GITHUB_SHA,
        ref: process.env.GITHUB_REF,
        repository: process.env.GITHUB_REPOSITORY,
      });
      appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
    } else if (
      command === "observe" &&
      ["before", "after"].includes(phase) &&
      evidence &&
      !extra.length
    ) {
      const previous =
        phase === "after" ? JSON.parse(readFileSync(`${evidence}.before.json`, "utf8")) : undefined;
      const identity = await observeStaging({ expected, previous });
      mkdirSync(dirname(evidence), { recursive: true });
      writeFileSync(`${evidence}.${phase}.json`, `${JSON.stringify(identity)}\n`);
      // A ledger names the served candidate only after the entire set was observed.
      if (phase === "after" && commitPath) writeFileSync(commitPath, `${identity.sha}\n`);
      console.log(`Staging candidate identity verified (${phase})`);
    } else {
      throw new Error("Invalid staging provenance command");
    }
  } catch {
    // Never echo an origin response, event title, token or arbitrary exception body.
    console.error("::error::Staging provenance refused; qualification is not evidence");
    process.exitCode = 1;
  }
}
