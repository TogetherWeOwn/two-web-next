// Linux cgroup v2 provenance. Unknown limits are unavailable, never "unlimited".
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";

export const RUNNER_IMAGE =
  "node:24-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413";
function requireValue(ok) {
  if (!ok) throw new Error("Invalid or unavailable startup runner provenance");
}
function read(file) {
  const stat = statSync(file);
  requireValue(stat.isFile() && stat.size <= 16384);
  // procfs/cgroupfs report zero size; bound allocation, not just reported size.
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (n === 0) break;
      length += n;
    }
    requireValue(length <= 16384);
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function optional(readFile, file) {
  try {
    return readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function controllers(text) {
  requireValue(typeof text === "string" && text.length <= 4096 && /^[a-z_\s]*$/.test(text));
  return text.trim().split(/\s+/).filter(Boolean).sort();
}
export function parseCpuList(text) {
  requireValue(
    typeof text === "string" &&
      text.length <= 4096 &&
      /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(text.trim()),
  );
  const ids = [];
  let previous = -1;
  for (const range of text.trim().split(",")) {
    const [first, last = first] = range.split("-").map(Number);
    requireValue(
      first > previous && last >= first && last <= 65535 && ids.length + last - first + 1 <= 65536,
    );
    for (let i = first; i <= last; i++) ids.push(i);
    previous = last;
  }
  return ids;
}
export function parseQuota(text) {
  requireValue(
    typeof text === "string" && text.length <= 128 && /^(max|[1-9]\d*) [1-9]\d*\n?$/.test(text),
  );
  const [quota, period] = text.trim().split(" ");
  const periodUs = Number(period);
  const quotaUs = quota === "max" ? null : Number(quota);
  requireValue(
    Number.isSafeInteger(periodUs) &&
      periodUs >= 1000 &&
      periodUs <= 1000000 &&
      (quotaUs === null ||
        (Number.isSafeInteger(quotaUs) && quotaUs >= 1000 && quotaUs <= 65536000000)),
  );
  return { quotaUs, periodUs };
}
export function cpuLimits(readFile = read) {
  const membership = readFile("/proc/self/cgroup").trim();
  requireValue(membership.length <= 4096 && membership.startsWith("0::/"));
  const group = membership.slice(3);
  // Root membership can hide ancestor quotas in a private cgroup namespace.
  requireValue(
    group
      .split("/")
      .slice(1)
      .every((part) => /^[\w.@:-]+$/.test(part) && part !== "." && part !== ".."),
  );
  const mounts = readFile("/proc/self/mountinfo")
    .trim()
    .split("\n")
    .filter((line) => line.includes(" - cgroup2 "));
  requireValue(mounts.length === 1);
  const fields = mounts[0].split(" ");
  // Require the full hierarchy, not a subtree mount that hides parent quotas.
  requireValue(fields[3] === "/" && fields[4] === "/sys/fs/cgroup");
  const dirs = [];
  for (let current = group; ; current = dirname(current)) {
    requireValue(dirs.length < 64);
    dirs.push(current);
    if (current === "/") break;
  }
  dirs.reverse();
  let parentEnabled = [];
  let cpuset = null;
  let effectiveCores = null;
  const hierarchy = dirs.map((path, i) => {
    const directory = join("/sys/fs/cgroup", path);
    const enabled = controllers(readFile(join(directory, "cgroup.subtree_control")));
    const available = controllers(readFile(join(directory, "cgroup.controllers")));
    const raw = optional(readFile, join(directory, "cpu.max"));
    const set = optional(readFile, join(directory, "cpuset.cpus.effective"));
    // No cpu.max is valid only at the root or when the parent's CPU controller
    // is demonstrably disabled. Never infer an unlimited state from ENOENT alone.
    requireValue(raw !== null || i === 0 || !parentEnabled.includes("cpu"));
    requireValue(set !== null || (i > 0 && !parentEnabled.includes("cpuset")));
    const quota = raw === null ? null : parseQuota(raw);
    if (quota?.quotaUs !== null && quota !== null) {
      const cores = quota.quotaUs / quota.periodUs;
      effectiveCores = effectiveCores === null ? cores : Math.min(effectiveCores, cores);
    }
    if (set !== null) {
      const next = parseCpuList(set);
      requireValue(cpuset === null || next.every((id) => cpuset.includes(id)));
      cpuset = next;
    }
    parentEnabled = enabled;
    return { path, available, enabled, quota, cpuset: set?.trim() ?? null };
  });
  requireValue(cpuset !== null);
  const status = readFile("/proc/self/status");
  const affinityRows = status.split("\n").filter((line) => line.startsWith("Cpus_allowed_list:"));
  requireValue(affinityRows.length === 1);
  const affinity = affinityRows[0].split(":")[1].trim();
  const allowed = parseCpuList(affinity);
  requireValue(allowed.every((id) => cpuset.includes(id)));
  return {
    version: 2,
    hierarchy,
    quotaState: effectiveCores === null ? "verified-unlimited" : "limited",
    quotaCores: effectiveCores,
    affinity,
    effectiveCpuCount: Math.min(allowed.length, effectiveCores ?? allowed.length),
  };
}
export function runnerIdentity({ readFile = read, env = process.env } = {}) {
  requireValue(
    platform() === "linux" && arch() === "x64" && process.versions.node.split(".")[0] === "24",
  );
  // CI selects this immutable image. Local integrations must explicitly use the
  // same digest; arbitrary host runs do not establish a controlled image.
  requireValue(env.STARTUP_RUNNER_IMAGE === RUNNER_IMAGE);
  const osRelease = readFile("/etc/os-release");
  requireValue(
    osRelease.length <= 4096 &&
      /^ID=debian$/m.test(osRelease) &&
      /^VERSION_CODENAME=bookworm$/m.test(osRelease),
  );
  const processors = cpus();
  requireValue(
    processors.length > 0 && processors.length <= 65536 && processors[0].model.length <= 256,
  );
  return {
    kind: env.GITHUB_ACTIONS === "true" ? "github-actions/check" : "local/container",
    image: RUNNER_IMAGE,
    osReleaseSha256: createHash("sha256").update(osRelease).digest("hex"),
    os: platform(),
    arch: arch(),
    kernel: release(),
    node: process.version,
    cpu: processors[0].model,
    cpuCount: processors.length,
    memoryBytes: totalmem(),
    limits: cpuLimits(readFile),
  };
}
