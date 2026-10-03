// Preparation only: no fetch handler, Wrangler config, deploy or public SQL route.
// A future approved PRIVATE Worker entrypoint must supply its actual bindings and
// freshly authenticated control-plane records. Offline fixtures are not evidence.
import postgres from "postgres";
import { requireStagingPreflight, type StagingPreflight } from "./staging-preflight";
import { runFixedStagingChecks } from "./staging-checks";

type Env = { DB?: Hyperdrive; CF_VERSION_METADATA?: { id: string } };

// Runtime fields only; never accept a URL or ambient PG* options. Caller validates the target first.
// Source: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
export function openHyperdriveClient(binding: Hyperdrive) {
  return postgres({
    host: binding.host,
    port: binding.port,
    username: binding.user,
    password: () => binding.password,
    database: binding.database,
    ssl: false,
    max: 1,
    fetch_types: false,
    prepare: true,
    connect_timeout: 5,
    connection: {
      application_name: "w1-staging-hyperdrive",
      statement_timeout: 5000,
      lock_timeout: 2000,
    },
  });
}

export async function runStagingProbe(
  env: Env,
  evidence: StagingPreflight,
  executorAgentId: string,
) {
  // No SQL or driver construction before current, executor-specific mapping checks.
  requireStagingPreflight(evidence, executorAgentId);
  const binding = env.DB;
  if (
    !binding ||
    typeof binding.connect !== "function" ||
    env.CF_VERSION_METADATA?.id !== evidence.worker.versionId ||
    !binding.host ||
    !Number.isInteger(binding.port) ||
    binding.port < 1 ||
    binding.port > 65535 ||
    !binding.user ||
    !binding.password ||
    binding.database !== evidence.neon.database ||
    binding.user !== evidence.neon.user ||
    binding.host === evidence.hyperdrive.origin.host ||
    binding.host === "agent-testdb" ||
    binding.host.endsWith(".neon.tech")
  ) {
    throw new Error("actual_worker_hyperdrive_binding_required");
  }
  try {
    const result = await runFixedStagingChecks(() => openHyperdriveClient(binding));
    return { ...result, path: "worker-hyperdrive-neon-staging" };
  } catch {
    // Driver errors can contain credentials/SQL. Never serialize them.
    throw new Error("staging_probe_failed_cleanup_not_verified");
  }
}
