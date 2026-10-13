// Staging-only admission containment.
//
// Host-controlled reversible contract for the staging web-migration path:
// - STAGING_MIGRATION_HOLD === "false" releases staging; every other value
//   (absent, empty, "true", malformed) holds it. Exact-string match only: no
//   case folding, trimming, or permissive fallback.
// - The hold applies to staging ONLY. Production keeps its existing
//   PRODUCTION_DEPLOY_ENABLED=true gate and ignores the hold entirely, so a
//   staging hold can never disable the independently authorized production path.
// - Single source for admission: migrationConfig (ci/neon-migrate.mjs) calls
//   assertMigrationAdmission below, so these messages are the ones operators
//   see. Checked before URL parsing, driver construction, or any database
//   work, and mirrored in workflow shell gates before dependency install or
//   mutation.
class AdmissionError extends Error {}

const refuse = (message) => {
  throw new AdmissionError(message);
};

export function stagingHoldState(value) {
  return value === "false" ? "released" : "held";
}

export function assertMigrationAdmission(env) {
  const target = env.MIGRATION_TARGET;
  if (target !== "staging" && target !== "production")
    refuse("Target must be staging or production.");
  if (env.GITHUB_REF !== "refs/heads/main") refuse("Migrations require the reviewed main branch.");
  if (target === "production") {
    if (env.PRODUCTION_DEPLOY_ENABLED !== "true")
      refuse("Production migrations require PRODUCTION_DEPLOY_ENABLED=true.");
    return { target, held: false };
  }
  assertStagingDeployHold(env);
  return { target, held: false };
}

// Direct staging deploy path (deploy.yml): always staging, no target input.
// Refuses held staging before dependencies, DB or Cloudflare work. Carries no
// ref or production claim: production migrations never flow through this path.
export function assertStagingDeployHold(env) {
  if (env.STAGING_MIGRATION_HOLD !== "false")
    refuse(
      'Staging migrations are held (STAGING_MIGRATION_HOLD is not exactly "false"; absent, "true" and malformed values all hold).',
    );
  return { target: "staging", held: false };
}
