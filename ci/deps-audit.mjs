import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import registry from "./deps-audit-registry.cjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const knownSeverities = new Set(["info", "low", "moderate", "high", "critical"]);
// Every lockfile root audited by the gate. "." is the repository root,
// "web" is the Kit workspace at web/. Keys in the printed result and the
// optional allowlist `lockfile` scope use exactly these labels.
const lockfileLabels = [".", "web"];
// A single attempt can catch a registry-edge stall that a fresh attempt sails
// through (npm normally answers in seconds), so retry the *execution* of
// `npm audit` a bounded number of times. Findings, invalid reports and
// permanent registry-boundary failures still fail immediately. Exhaustion stays
// blocking unless every attempt proves a registry outage. Attempts = delays + 1.
const auditTimeoutMs = 120_000;
const auditRetryDelaysMs = [5_000, 15_000];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

function date(value) {
  if (
    !text(value) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Allowlist dates must be real YYYY-MM-DD UTC dates");
  }
  return value;
}

function validateAllowlist(allowlist, today = new Date().toISOString().slice(0, 10)) {
  date(today);
  if (!isObject(allowlist) || allowlist.version !== 1 || !Array.isArray(allowlist.exceptions)) {
    throw new Error("Invalid dependency audit allowlist");
  }
  const seen = new Set();
  for (const entry of allowlist.exceptions) {
    if (
      !isObject(entry) ||
      !text(entry.package) ||
      !text(entry.range) ||
      !text(entry.reason) ||
      !["high", "critical"].includes(entry.severity) ||
      !Array.isArray(entry.advisoryIds) ||
      entry.advisoryIds.length === 0 ||
      entry.advisoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(entry.advisoryIds).size !== entry.advisoryIds.length
    ) {
      throw new Error(
        "Invalid exception: package, range, severity, advisoryIds and reason are required",
      );
    }
    if (entry.lockfile !== undefined && !lockfileLabels.includes(entry.lockfile)) {
      throw new Error(`Invalid lockfile scope for ${entry.package}`);
    }
    if (
      date(entry.reviewed) > today ||
      date(entry.expires) <= today ||
      entry.expires <= entry.reviewed
    ) {
      throw new Error(`Expired or invalid exception dates for ${entry.package}`);
    }
    const scopeKey = `${entry.lockfile ?? "*"}:${entry.package}`;
    if (seen.has(scopeKey)) throw new Error(`Duplicate exception for ${entry.package}`);
    seen.add(scopeKey);
  }
}

export function evaluateAudit(
  report,
  allowlist,
  today = new Date().toISOString().slice(0, 10),
  lockfile = undefined,
) {
  date(today);
  if (lockfile !== undefined && !lockfileLabels.includes(lockfile)) {
    throw new Error('Invalid lockfile scope (expected "." or "web")');
  }
  if (
    !isObject(report) ||
    report.error ||
    report.auditReportVersion !== 2 ||
    !isObject(report.vulnerabilities) ||
    !isObject(report.metadata?.vulnerabilities)
  ) {
    throw new Error("Invalid npm audit v2 report (or registry error)");
  }
  const vulnerabilities = report.vulnerabilities;
  const counters = report.metadata.vulnerabilities;
  const counterKeys = [...knownSeverities, "total"];
  if (
    Object.keys(counters).some((key) => !counterKeys.includes(key)) ||
    counterKeys.some((key) => !Number.isSafeInteger(counters[key]) || counters[key] < 0)
  ) {
    throw new Error("Invalid audit vulnerability counters");
  }
  if (
    counters.total !== Object.keys(vulnerabilities).length ||
    [...knownSeverities].reduce((sum, severity) => sum + counters[severity], 0) !== counters.total
  ) {
    throw new Error("Audit vulnerability counts do not match the total");
  }
  // npm counts packages by their reported severity, not by individual "via"
  // advisories. Validate that accounting before applying our stricter via policy.
  const counts = Object.fromEntries([...knownSeverities].map((severity) => [severity, 0]));
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!knownSeverities.has(vulnerability?.severity)) {
      throw new Error(`Unknown package severity for ${name}`);
    }
    counts[vulnerability.severity]++;
  }
  if ([...knownSeverities].some((severity) => counts[severity] !== counters[severity])) {
    throw new Error("Audit severity counts do not match the package records");
  }
  validateAllowlist(allowlist, today);

  // npm's string "via" entries reference another vulnerable package. Include its
  // advisory IDs so a new transitive advisory cannot silently inherit an exception.
  function advisories(name) {
    const visited = new Set([name]);
    const pending = [name];
    const ids = new Set();
    const severities = new Set();
    // Valid npm metavulnerability graphs can contain cycles. Each reachable
    // package is visited once per root, bounding work even for shared descendants.
    while (pending.length > 0) {
      const current = pending.pop();
      const vulnerability = Object.hasOwn(vulnerabilities, current)
        ? vulnerabilities[current]
        : undefined;
      if (
        !isObject(vulnerability) ||
        vulnerability.name !== current ||
        !text(vulnerability.range) ||
        !Array.isArray(vulnerability.via) ||
        vulnerability.via.length === 0
      ) {
        throw new Error(`Invalid vulnerability or via reference for ${current}`);
      }
      severities.add(vulnerability.severity);
      for (const via of vulnerability.via) {
        if (typeof via === "string") {
          if (!visited.has(via)) {
            visited.add(via);
            pending.push(via);
          }
        } else if (isObject(via) && Number.isSafeInteger(via.source) && via.source > 0) {
          ids.add(via.source);
          severities.add(via.severity);
        } else {
          throw new Error(`Invalid advisory for ${current}`);
        }
      }
    }
    if (ids.size === 0) throw new Error(`No reachable advisory for ${name}`);
    return { ids: [...ids].sort((a, b) => a - b), severities: [...severities] };
  }

  const result = { blocked: [], allowed: [], nonBlocking: [] };
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const { ids, severities } = advisories(name);
    const unknown = severities.some((severity) => !knownSeverities.has(severity));
    const severity = unknown
      ? "unknown"
      : severities.includes("critical")
        ? "critical"
        : severities.includes("high")
          ? "high"
          : vulnerability.severity;
    if (!["high", "critical", "unknown"].includes(severity)) {
      result.nonBlocking.push(name);
      continue;
    }
    const exception = allowlist.exceptions.find(
      (entry) =>
        entry.package === name &&
        entry.range === vulnerability.range &&
        entry.severity === severity &&
        (entry.lockfile === undefined || entry.lockfile === lockfile) &&
        JSON.stringify([...entry.advisoryIds].sort((a, b) => a - b)) === JSON.stringify(ids),
    );
    const finding = { package: name, severity, range: vulnerability.range, advisoryIds: ids };
    if (exception && !unknown) result.allowed.push({ ...finding, expires: exception.expires });
    else result.blocked.push(finding);
  }
  return result;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Only these GitHub events tolerate an exhausted registry outage as a warning.
// push (main), schedule, workflow_dispatch and local/unknown runs fail closed.
const outageTolerantEvents = new Set(["pull_request", "merge_group"]);

export function isOutageTolerantEvent(eventName = process.env.GITHUB_EVENT_NAME ?? "") {
  return outageTolerantEvents.has(eventName);
}

export class RegistryTransportExhausted extends Error {
  constructor(label, kind, attempts) {
    super(
      `Registry transport failure for "${label}" after ${attempts} attempts (${kind}); audit unavailable`,
    );
    this.name = "RegistryTransportExhausted";
    this.label = label;
    this.kind = kind;
    this.attempts = attempts;
  }
}

// fd 3 is a journal of synchronous preload snapshots. Parse every entry so a
// malformed/truncated journal stays blocking; the last snapshot survives kills.
function readBoundary(audit) {
  try {
    const lines = (audit.output?.[3] ?? "").trim().split("\n");
    const states = lines.map((line) => JSON.parse(line));
    return states.at(-1);
  } catch {
    return null;
  }
}

function observedBoundary(boundary) {
  return (
    isObject(boundary) &&
    boundary.version === 1 &&
    typeof boundary.valid === "boolean" &&
    Number.isSafeInteger(boundary.responses) &&
    boundary.responses >= 0 &&
    Number.isSafeInteger(boundary.pending) &&
    boundary.pending >= 0
  );
}

function classifyRegistryTransport(boundary, timedOut = false) {
  // Only typed request errors / HTTP status captured at the actual bulk request
  // are evidence. npm's message may contain arbitrary response-body or URL text.
  if (!observedBoundary(boundary) || boundary.permanent !== false) return null;
  if (timedOut) return boundary.pending > 0 ? { kind: "timeout" } : null;
  if (boundary.valid !== false || boundary.responses < 1 || boundary.pending !== 0) return null;
  const transport = boundary.transport;
  if (!isObject(transport)) return null;
  if (
    transport.kind === "http" &&
    Number.isSafeInteger(transport.statusCode) &&
    transport.statusCode >= 500 &&
    transport.statusCode <= 599
  )
    return { kind: "http-5xx" };
  if (transport.kind === "network" && registry.transientNetworkCodes.has(transport.code)) {
    return { kind: "network" };
  }
  return null;
}

export function auditOneLockfile({
  label,
  dir,
  guard,
  allowlist,
  cacheParent,
  spawn = spawnSync,
  sleep = sleepSync,
  timeoutMs = auditTimeoutMs,
  retryDelaysMs = auditRetryDelaysMs,
}) {
  const lockfilePath = join(dir, "package-lock.json");
  if (!existsSync(lockfilePath)) {
    throw new Error(`Missing lockfile for "${label}" at ${lockfilePath}`);
  }
  const attempts = retryDelaysMs.length + 1;
  let exhaustedTransport = null;
  let allTransport = true;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // No install scripts, node_modules or application/database credentials needed.
    // npm's advisory cache can retain old severity even after an online response.
    // Override inherited config with a fresh, owned cache for every attempt so a
    // poisoned or partial cache can never leak into a retry.
    const cache = join(cacheParent, label === "." ? "root" : label, `attempt-${attempt}`);
    mkdirSync(cache, { recursive: true });
    const retryLog = (detail) =>
      console.error(
        `Dependency audit for "${label}": attempt ${attempt} of ${attempts} ${detail}; retrying in ${retryDelaysMs[attempt - 1]}ms`,
      );
    const audit = spawn(
      "npm",
      [
        "audit",
        "--offline=false",
        `--cache=${cache}`,
        "--package-lock-only",
        "--json",
        "--include=prod",
        "--include=dev",
        "--include=optional",
        "--include=peer",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          DEPS_AUDIT_REGISTRY_GUARD: "1",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(guard)}`,
        },
      },
    );
    const boundary = readBoundary(audit);
    if (observedBoundary(boundary) && boundary.permanent === true) {
      throw new Error(`Registry advisory response was not schema-validated for "${label}"`);
    }
    // A timeout is transport only while an observed bulk request is pending and
    // no permanent failure has been seen. Unknown local stalls can retry, but
    // can never make the exhausted sequence outage-eligible.
    if (audit.error !== undefined) {
      if (audit.error.code === "ETIMEDOUT") {
        const transport = classifyRegistryTransport(boundary, true);
        allTransport &&= transport !== null;
        exhaustedTransport = transport;
        if (attempt === attempts) break;
        retryLog("did not complete");
        sleep(retryDelaysMs[attempt - 1]);
        continue;
      }
      throw new Error(`npm audit did not complete successfully for "${label}"`);
    }
    // Crashed or signal-killed runs (OOM, runner kill) retry bounded like
    // before, but a bare non-0/1 exit is never transport: exhaustion stays
    // blocking.
    if (![0, 1].includes(audit.status)) {
      allTransport = false;
      if (attempt === attempts) break;
      retryLog("did not complete");
      sleep(retryDelaysMs[attempt - 1]);
      continue;
    }
    try {
      const report = JSON.parse(audit.stdout);
      if (
        !observedBoundary(boundary) ||
        boundary.valid !== true ||
        boundary.responses < 1 ||
        boundary.pending !== 0
      ) {
        const transport =
          isObject(report) && isObject(report.error) ? classifyRegistryTransport(boundary) : null;
        if (transport !== null) {
          if (attempt === attempts) {
            exhaustedTransport = transport;
            break;
          }
          retryLog(`hit registry transport failure (${transport.kind})`);
          sleep(retryDelaysMs[attempt - 1]);
          continue;
        }
        throw new Error(`Registry advisory response was not schema-validated for "${label}"`);
      }
      return evaluateAudit(report, allowlist, undefined, label);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON for "${label}"`);
      throw error;
    }
  }
  if (allTransport && exhaustedTransport !== null) {
    throw new RegistryTransportExhausted(label, exhaustedTransport.kind, attempts);
  }
  throw new Error(`npm audit did not complete successfully for "${label}"`);
}

export function runAudit() {
  // One owned parent cache; each lockfile gets its own fresh child cache so a
  // retained advisory severity in one lockfile cannot leak into the other.
  const cacheParent = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-cache-",
    ),
  );
  try {
    const guard = fileURLToPath(new URL("./deps-audit-registry.cjs", import.meta.url));
    const allowlist = JSON.parse(
      readFileSync(new URL("./deps-audit-allowlist.json", import.meta.url), "utf8"),
    );
    validateAllowlist(allowlist);
    const lockfiles = [
      { label: ".", dir: root },
      { label: "web", dir: join(root, "web") },
    ];
    const results = {};
    const outages = [];
    for (const { label, dir } of lockfiles) {
      try {
        results[label] = auditOneLockfile({ label, dir, guard, allowlist, cacheParent });
      } catch (error) {
        // An outage in one lockfile must not hide an advisory in the other:
        // record it as unavailable (never clean) and keep auditing. Permanent
        // failures still throw immediately and fail closed on every event.
        if (error instanceof RegistryTransportExhausted) {
          results[label] = {
            unavailable: true,
            reason: "registry-transport",
            kind: error.kind,
            attempts: error.attempts,
          };
          outages.push({ label, kind: error.kind, attempts: error.attempts });
          continue;
        }
        throw error;
      }
    }
    // Do not print raw registry responses or stderr; only policy findings.
    // One result per lockfile, keyed by the lockfile label. stdout stays pure
    // JSON; annotations go to stderr so JSON consumers never see them.
    console.log(JSON.stringify(results, null, 2));
    const warnOutage = ({ label, kind, attempts }) =>
      console.error(
        `::warning::Dependency audit unavailable for "${label}" after ${attempts} attempts (${kind}); ` +
          "audit marked unavailable, not clean. Registry outages warn on pull_request/merge_group and fail closed elsewhere.",
      );
    if (
      Object.values(results).some(
        (result) => Array.isArray(result.blocked) && result.blocked.length > 0,
      )
    ) {
      for (const outage of outages) warnOutage(outage);
      process.exitCode = 1;
      return;
    }
    if (outages.length > 0) {
      const event = process.env.GITHUB_EVENT_NAME ?? "";
      if (isOutageTolerantEvent(event)) {
        for (const outage of outages) warnOutage(outage);
        return;
      }
      for (const outage of outages) {
        console.error(
          `Dependency audit unavailable for "${outage.label}" after ${outage.attempts} attempts (${outage.kind}); ` +
            `failing closed on event "${event || "local"}".`,
        );
      }
      process.exitCode = 1;
    }
  } finally {
    rmSync(cacheParent, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runAudit();
  } catch (error) {
    console.error(
      `Dependency audit failed: ${error instanceof SyntaxError ? "Invalid JSON" : error.message}`,
    );
    process.exitCode = 1;
  }
}
