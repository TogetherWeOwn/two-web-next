// Release identity for structured logs. The deploy workflows tag every
// Worker Version with the commit it was built from (staging: the bare
// 40-hex SHA; production: `<sha>-<run-id>-<run-attempt>`), and the
// `version_metadata` binding (`CF_VERSION_METADATA`) exposes that tag at
// runtime. Parsing accepts only those two shapes and emits only the
// 40-hex component, so an arbitrary manual tag can never reach a log line
// (or, via src/up-revision.ts, a public body).
//
// The parsed fields are cached per isolate: a Worker Version cannot change
// under a running isolate, so the first request or queue batch that seeds
// the cache (src/request-log.ts, src/jobs/worker.ts) fixes it for the
// isolate's lifetime. Alert emitters read the cache (src/alerts.ts) rather
// than threading env through every call site.
export type ReleaseFields = { build_sha: string | null; release: string | null };

const VERSION_TAG = /^([0-9a-f]{40})(?:-\d+-\d+)?$/;

/** The deploy commit encoded in a Worker Version tag, or null for any other shape. */
export function buildShaFromTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  return VERSION_TAG.exec(tag)?.[1] ?? null;
}

/** Log fields for a `CF_VERSION_METADATA` binding value; both null when unbound or untagged. */
export function releaseFields(meta: { tag?: unknown } | null | undefined): ReleaseFields {
  const sha = buildShaFromTag(meta?.tag);
  return { build_sha: sha, release: sha };
}

let current: ReleaseFields = { build_sha: null, release: null };

/** Seed the per-isolate release identity from the version-metadata binding. */
export function setReleaseMetadata(meta: { tag?: unknown } | null | undefined): void {
  current = releaseFields(meta);
}

/** The release fields every structured log line carries (nulls until seeded with a tagged version). */
export function currentReleaseFields(): ReleaseFields {
  return current;
}

/** Test-only: clear the per-isolate cache so cases stay independent. */
export function __resetReleaseForTests(): void {
  current = { build_sha: null, release: null };
}
