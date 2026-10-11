// Deployed-revision marker (staging only: the `version_metadata` binding is
// declared at the top level of wrangler.jsonc and, like every binding, is not
// inherited by `env.production`, so a production `/up` body stays unchanged).
// `version_id` is the Worker Version ID: the exact value `wrangler rollback`
// takes, so a rollback is proven by reading it back from the live Worker.
// `commit` is the deploy tag, accepted only as a full lowercase SHA-1 so an
// arbitrary manual tag never reaches a public body; otherwise `null`.
export type RevisionReadiness = {
  revision?: { version_id: string; commit: string | null };
};

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function revisionReadiness(
  meta: { id?: unknown; tag?: unknown } | null | undefined,
): RevisionReadiness {
  if (typeof meta?.id !== "string" || meta.id === "") return {};
  const commit = typeof meta.tag === "string" && COMMIT_SHA.test(meta.tag) ? meta.tag : null;
  return { revision: { version_id: meta.id, commit } };
}
