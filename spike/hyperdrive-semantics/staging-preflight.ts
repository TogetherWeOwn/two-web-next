// Non-secret control-plane evidence only. Validation is not authentication:
// the executor must collect these records through their OWN existing read route.
export const STAGING_TARGET = {
  project: "two-web-next", branch: "staging",
  hyperdriveName: "two-web-next-staging",
  hyperdriveId: "1d48a54abd3444009b7067c03c63ff9f",
} as const;
export const REQUIRED_READS = ["workers.settings.read", "hyperdrive.read", "neon.branch.read"] as const;
export const PREFLIGHT_MAX_AGE_MS = 300_000;

export interface StagingPreflight {
  observedAt: string;
  principal: { agentId: string; subject: string; transport: string; permittedVerbs: string[] };
  worker: { name: string; versionId: string; bindings: { name: string; type: string; id: string }[] };
  hyperdrive: {
    id: string; name: string; cachingDisabled: boolean;
    origin: { host: string; database: string; user: string };
  };
  neon: {
    projectId: string; projectName: string; branchId: string; branchName: string;
    defaultBranch: boolean;
    endpoint: { branchId: string; host: string };
    database: string; user: string;
  };
}

export function requireStagingPreflight(
  evidence: StagingPreflight, executorAgentId: string, now = Date.now(),
): void {
  const fail = () => { throw new Error("staging_preflight_not_verified"); };
  const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const time = Date.parse(evidence?.observedAt);
  if (!Number.isFinite(time) || time > now || now - time > PREFLIGHT_MAX_AGE_MS) fail();
  const principal = evidence?.principal;
  if (!present(executorAgentId) || principal?.agentId !== executorAgentId ||
      !present(principal?.subject) || !present(principal?.transport) ||
      !Array.isArray(principal?.permittedVerbs) ||
      !REQUIRED_READS.every((verb) => principal?.permittedVerbs?.includes(verb))) fail();
  const worker = evidence?.worker;
  // Discover name/version from Worker settings, never from the Hyperdrive name.
  if (!present(worker?.name) || !present(worker?.versionId) || !Array.isArray(worker?.bindings) ||
      worker.bindings.filter((binding) => binding.name === "DB").length !== 1 ||
      !worker.bindings.some((binding) => binding.name === "DB" && binding.type === "hyperdrive" &&
        binding.id === STAGING_TARGET.hyperdriveId)) fail();
  const hd = evidence?.hyperdrive;
  const neon = evidence?.neon;
  if (hd?.id !== STAGING_TARGET.hyperdriveId || hd?.name !== STAGING_TARGET.hyperdriveName ||
      hd?.cachingDisabled !== true || neon?.projectName !== STAGING_TARGET.project ||
      neon?.branchName !== STAGING_TARGET.branch || neon?.defaultBranch !== false ||
      !present(neon?.projectId) || !present(neon?.branchId) ||
      neon?.endpoint?.branchId !== neon?.branchId || !present(neon?.endpoint?.host) ||
      hd?.origin?.host !== neon?.endpoint?.host ||
      !present(neon?.database) || hd?.origin?.database !== neon?.database ||
      !present(neon?.user) || hd?.origin?.user !== neon?.user) fail();
}
