export const ownerLabel = "join-evidence-owner";

const idPattern = /^[0-9a-f]{12,64}$/;
const missingPattern = /no such (object|container)/i;
const complete = (result) => !result.timedOut && result.drained !== false;

export class ContainerCleanupError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ContainerCleanupError";
    this.containerRef = details.containerRef;
    this.cleanupVerified = false;
  }
}

export async function inspectContainer(docker, ref, timeoutMs) {
  const format = `{"State":{{json .State}},"Labels":{{json .Config.Labels}}}`;
  const result = await docker(["inspect", "--format", format, ref], { timeoutMs });
  if (result.timedOut) return { status: "unknown", reason: "inspect timed out" };
  if (result.drained === false)
    return { status: "unknown", reason: "inspect output not fully drained" };
  if (result.code !== 0) {
    return missingPattern.test(result.stderr)
      ? { status: "missing" }
      : { status: "unknown", reason: `inspect failed: ${result.stderr.trim()}` };
  }
  try {
    const { State: state, Labels: labels } = JSON.parse(result.stdout);
    if (typeof state?.Running !== "boolean")
      return { status: "unknown", reason: "inspect state malformed" };
    return {
      status: "present",
      running: state.Running,
      exitCode: state.ExitCode,
      owner: labels?.[ownerLabel],
    };
  } catch {
    return { status: "unknown", reason: "inspect output unparseable" };
  }
}

async function findOwned(docker, token, timeoutMs) {
  const listed = await docker(
    ["ps", "-aq", "--no-trunc", "--filter", `label=${ownerLabel}=${token}`],
    { timeoutMs },
  );
  if (!complete(listed) || listed.code !== 0)
    return {
      ok: false,
      reason: `ownership lookup failed: ${listed.timedOut ? "timed out" : listed.stderr.trim() || "incomplete output"}`,
    };
  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!ids.every((id) => idPattern.test(id)))
    return { ok: false, reason: "ownership lookup returned malformed ids" };
  return { ok: true, ids };
}

// Only remove a container whose inspected ownership label matches this invocation.
export async function removeOwned(docker, ref, token, timeoutMs) {
  const before = await inspectContainer(docker, ref, timeoutMs);
  if (before.status === "missing") return;
  if (before.status === "unknown")
    throw new ContainerCleanupError(`container ${ref} cleanup not verified: ${before.reason}`, {
      containerRef: ref,
    });
  if (before.owner !== token)
    throw new ContainerCleanupError(
      `container ${ref} is not owned by this supervisor; left untouched`,
      { containerRef: ref },
    );
  const problems = [];
  const kill = await docker(["kill", ref], { timeoutMs });
  if (kill.timedOut) problems.push("kill timed out");
  const rm = await docker(["rm", "--force", "--volumes", ref], { timeoutMs });
  if (rm.timedOut) problems.push("rm timed out");
  else if (rm.code !== 0 && !missingPattern.test(rm.stderr))
    problems.push(`rm failed: ${rm.stderr.trim()}`);
  const after = await inspectContainer(docker, ref, timeoutMs);
  if (after.status === "missing") return;
  problems.push(
    after.status === "present"
      ? `container still present (running=${after.running})`
      : after.reason,
  );
  throw new ContainerCleanupError(`container ${ref} cleanup not verified: ${problems.join("; ")}`, {
    containerRef: ref,
  });
}

// A failed create may complete later, even after the current ownership lookup is empty.
export async function cleanupWithoutId(docker, token, timeoutMs) {
  const owned = await findOwned(docker, token, timeoutMs);
  if (!owned.ok) throw new ContainerCleanupError(owned.reason, { containerRef: null });
  for (const id of owned.ids) await removeOwned(docker, id, token, timeoutMs);
  throw new ContainerCleanupError(
    "create outcome is ambiguous and may complete later; cleanup cannot be verified",
    { containerRef: null },
  );
}
