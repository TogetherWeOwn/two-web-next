import { addAbortListener } from "node:events";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { liveVersion, readLiveRevision, rollbackEnvironment } from "./rollback-target.mjs";
import { isSha } from "./staging-provenance.mjs";

// Cloudflare's deployments API allows up to 100 rows per page, each with a
// message of up to 1,000 bytes. Allow for JSON escaping and version metadata.
const DEPLOYMENT_RESPONSE_BYTES = 1024 * 1024;
// GitHub compare returns one commit with per_page=1, but its first page can
// include 300 changed files and patches. GitHub documents no compare byte
// ceiling. Allow 8 MiB for the patches, JSON escaping, and commit/file metadata.
const ANCESTRY_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readProviderJson(response, signal, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing provider response body");
  const cancel = () => {
    // Cancel closes pending reads immediately. The source's cleanup may stall.
    void reader.cancel().catch(() => {});
  };
  const deadline = addAbortListener(signal, cancel);
  try {
    if (!response.ok) throw new Error("Request failed");
    const bytes = new Uint8Array(maxBytes);
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
      // Count decoded response bytes, including chunked or compressed replies.
      if (value.byteLength > maxBytes - length) throw new Error("Provider response too large");
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    deadline[Symbol.dispose]();
    cancel();
    reader.releaseLock();
  }
}

export function orderedDeploymentTime(value) {
  const parsed =
    typeof value === "string" &&
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parsed || parsed[0] !== value) throw new Error("Invalid staging deployment timestamp");
  const [, time, fraction = "", offset] = parsed;
  const wallClock = new Date(`${time}Z`).toJSON();
  const utc = new Date(`${time}${offset}`).toJSON();
  if (!utc || !wallClock?.startsWith(time)) {
    throw new Error("Invalid staging deployment timestamp");
  }
  return `${utc.slice(0, 19)}.${fraction.padEnd(9, "0")}Z`;
}

// The caller holds the shared staging lane through the last mutation. Check
// Cloudflare's active version as well as /up so a lagging edge cannot admit a
// stale deploy. Main's tip is irrelevant to whether the candidate is forward.
export async function requireForwardStaging(env, fetchImpl = fetch) {
  const target = env.CANDIDATE_SHA;
  const { GITHUB_REPOSITORY: repository, CLOUDFLARE_ACCOUNT_ID: account } = env;
  if (
    !isSha(target) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^[a-f0-9]{32}$/.test(account ?? "") ||
    !env.GITHUB_TOKEN ||
    !env.CLOUDFLARE_API_TOKEN
  ) {
    throw new Error("Invalid staging rollout inputs");
  }
  async function get(url, token, source, maxBytes) {
    try {
      const signal = AbortSignal.timeout(10_000);
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal,
      });
      return await readProviderJson(response, signal, maxBytes);
    } catch {
      throw new Error(`Cannot read ${source} for staging rollout`);
    }
  }

  const { worker, origin } = rollbackEnvironment("staging");
  const deployment = await get(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/deployments`,
    env.CLOUDFLARE_API_TOKEN,
    "Cloudflare deployment state",
    DEPLOYMENT_RESPONSE_BYTES,
  );
  const deployments = deployment?.result?.deployments;
  if (deployment?.success !== true || !Array.isArray(deployments) || !deployments.length) {
    throw new Error("Missing active staging deployment");
  }
  const ordered = deployments
    .map((item) => ({ ...item, created_on: orderedDeploymentTime(item?.created_on) }))
    .sort((a, b) => b.created_on.localeCompare(a.created_on));
  if (ordered[0].created_on === ordered[1]?.created_on) {
    throw new Error("Cannot determine the newest staging deployment");
  }
  const active = liveVersion([ordered[0]]);
  const revision = await readLiveRevision({ origin, fetchImpl }).catch(() => null);
  if (revision?.versionId !== active || !isSha(revision.commit)) {
    throw new Error("Staging /up does not identify the active Cloudflare version");
  }
  const live = revision.commit;
  // Same-SHA dispatch can still change staging route flags or repair a partial
  // rollout. The exact CI and all other admission gates still apply.
  if (target === live) return live;

  const comparison = await get(
    `https://api.github.com/repos/${repository}/compare/${live}...${target}?per_page=1`,
    env.GITHUB_TOKEN,
    "GitHub commit ancestry",
    ANCESTRY_RESPONSE_BYTES,
  );
  if (
    comparison?.status !== "ahead" ||
    comparison.base_commit?.sha !== live ||
    comparison.merge_base_commit?.sha !== live ||
    comparison.behind_by !== 0 ||
    !Number.isSafeInteger(comparison.ahead_by) ||
    comparison.ahead_by <= 0 ||
    comparison.total_commits !== comparison.ahead_by
  ) {
    throw new Error(`Staging rollout refused: ${target} is not a verified descendant of ${live}`);
  }
  return live;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const live = await requireForwardStaging(process.env);
    appendFileSync(process.env.GITHUB_OUTPUT, `live_sha=${live}\n`);
    console.log(`Staging rollout admitted: ${process.env.CANDIDATE_SHA} from ${live}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
