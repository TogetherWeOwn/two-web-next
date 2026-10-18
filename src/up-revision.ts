// Deployed-revision marker. The `version_metadata` binding is declared for
// the staging Worker (top level of wrangler.jsonc) and for `env.production`
// (bindings are not inherited, so each environment declares its own).
// `version_id` is the Worker Version ID: the exact value `wrangler rollback`
// takes, so a rollback is proven by reading it back from the live Worker.
// `commit` is the deploy commit parsed from the version tag by
// src/release-tag.ts (staging tags the bare SHA, production tags
// `<sha>-<run-id>-<run-attempt>`); only a full lowercase SHA-1 is emitted,
// so an arbitrary manual tag never reaches a public body, else `null`.
import { buildShaFromTag } from "./release-tag";

export type RevisionReadiness = {
  revision?: { version_id: string; commit: string | null };
};

export function revisionReadiness(
  meta: { id?: unknown; tag?: unknown } | null | undefined,
): RevisionReadiness {
  if (typeof meta?.id !== "string" || meta.id === "") return {};
  return { revision: { version_id: meta.id, commit: buildShaFromTag(meta.tag) } };
}
