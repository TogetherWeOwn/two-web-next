// Resolves which scripts revision the staging rollback drill legs check out.
//
// The drill rolls staging back and forward through rollback-production.yml,
// and both legs need rollback scripts from a commit that contains them. The
// live commit supplies them when it does; a live commit that predates them
// (staging behind the drill) falls back to the drill revision instead of
// failing the drill, and the rollback preflight still demands green
// exact-SHA CI for that revision, so the fallback fails closed.
//
// Prints the selected ref. Exit 0: the serving commit contains the scripts.
// Exit 3: fallback, the drill revision (the caller logs the notice). Any
// other failure exits nonzero so the caller fails instead of silently
// swapping the ref: an unreadable /up, a transport error, or a non-404
// GitHub answer must never look like "scripts absent".
import { pathToFileURL } from "node:url";
import { readLiveRevision } from "./rollback-target.mjs";
import { STAGING_ORIGIN } from "./operator-constants.mjs";

const SCRIPTS_PATH = "ci/rollback-target.mjs";
export const DRILL_SCRIPTS_REF_FALLBACK_EXIT = 3;

export async function resolveDrillScriptsRef({
  live,
  repository,
  token,
  drillSha,
  fetchImpl = fetch,
  readRevision = readLiveRevision,
  upOrigin = STAGING_ORIGIN,
}) {
  let revision;
  try {
    revision = await readRevision({ origin: upOrigin, fetchImpl });
  } catch (error) {
    throw new Error(
      `staging /up unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!revision?.commit || revision.versionId !== live) {
    throw new Error("staging /up does not name the live version with a known commit");
  }
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repository}/contents/${SCRIPTS_PATH}?ref=${revision.commit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    throw new Error(
      `rollback script check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) {
    return { ref: drillSha, fallback: true, serving: revision.commit };
  }
  if (!response.ok) {
    throw new Error(`rollback script check failed (HTTP ${response.status})`);
  }
  return { ref: revision.commit, fallback: false, serving: revision.commit };
}

export const DRILL_SCRIPTS_REF_USAGE =
  "Usage: LIVE=<live-version-id> node ci/drill-scripts-ref.mjs (reads GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_SHA)";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const live = process.env.LIVE ?? "";
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const token = process.env.GITHUB_TOKEN ?? "";
    const drillSha = process.env.GITHUB_SHA ?? "";
    if (!live || !repository || !token || !/^[0-9a-f]{40}$/.test(drillSha)) {
      console.error(DRILL_SCRIPTS_REF_USAGE);
      process.exitCode = 2;
    } else {
      const { ref, fallback, serving } = await resolveDrillScriptsRef({
        live,
        repository,
        token,
        drillSha,
      });
      if (fallback) {
        // Stderr: the caller's $(...) captures stdout as the ref, so a
        // notice on stdout would be swallowed into the ref value.
        console.error(
          `::notice::staging serves ${serving}, which predates the rollback scripts; both legs run the drill revision (${ref}) instead`,
        );
      }
      process.stdout.write(ref);
      process.exitCode = fallback ? DRILL_SCRIPTS_REF_FALLBACK_EXIT : 0;
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
