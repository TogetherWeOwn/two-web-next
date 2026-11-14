const SHA = /^[0-9a-f]{40}$/;

export function heldProduction({ liveSha, mainSha, comparison, nowMs }) {
  if (!SHA.test(liveSha ?? "") || !SHA.test(mainSha ?? "") || !Number.isFinite(nowMs)) {
    throw new Error("Missing production hold identity");
  }
  if (liveSha === mainSha) return { held: false, heldSince: null, hours: 0 };
  const oldest = comparison?.commits?.[0];
  const since = Date.parse(oldest?.commit?.committer?.date ?? "");
  if (
    comparison?.status !== "ahead" ||
    comparison.base_commit?.sha !== liveSha ||
    comparison.merge_base_commit?.sha !== liveSha ||
    comparison.behind_by !== 0 ||
    !Number.isSafeInteger(comparison.ahead_by) ||
    comparison.ahead_by <= 0 ||
    comparison.total_commits !== comparison.ahead_by ||
    !SHA.test(oldest?.sha ?? "") ||
    !Number.isFinite(since) ||
    since > nowMs
  ) {
    throw new Error("Cannot establish production hold age");
  }
  const hours = (nowMs - since) / 3_600_000;
  return { held: hours > 6, heldSince: new Date(since).toISOString(), hours };
}
