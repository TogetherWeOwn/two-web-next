import { pathToFileURL } from "node:url";
import { liveVersion, readLiveRevision, rollbackEnvironment } from "./rollback-target.mjs";

const isSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

// The caller holds the shared staging lane through the last mutation. Check
// Cloudflare's active version as well as /up so a lagging edge cannot admit a
// stale deploy. Main's tip is irrelevant to whether the candidate is forward.
export async function requireForwardStaging(env, fetchImpl = fetch) {
  const { DEPLOY_SHA: target, GITHUB_REPOSITORY: repository, CLOUDFLARE_ACCOUNT_ID: account } = env;
  if (
    !isSha(target) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^[a-f0-9]{32}$/.test(account ?? "") ||
    !env.GITHUB_TOKEN ||
    !env.CLOUDFLARE_API_TOKEN
  ) {
    throw new Error("Invalid staging rollout inputs");
  }
  async function get(url, token, source) {
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Request failed");
      return await response.json();
    } catch {
      throw new Error(`Cannot read ${source} for staging rollout`);
    }
  }

  const { worker, origin } = rollbackEnvironment("staging");
  const deployment = await get(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/deployments`,
    env.CLOUDFLARE_API_TOKEN,
    "Cloudflare deployment state",
  );
  if (deployment?.success !== true) throw new Error("Missing active staging deployment");
  const active = liveVersion(deployment.result?.deployments);
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
    console.log(`Staging rollout admitted: ${process.env.DEPLOY_SHA} from ${live}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
