import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const knownSeverities = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

function date(value) {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('Allowlist dates must be real YYYY-MM-DD UTC dates');
  }
  return value;
}

export function evaluateAudit(report, allowlist, today = new Date().toISOString().slice(0, 10)) {
  date(today);
  if (!isObject(report) || report.error || report.auditReportVersion !== 2
    || !isObject(report.vulnerabilities) || !isObject(report.metadata?.vulnerabilities)) {
    throw new Error('Invalid npm audit v2 report (or registry error)');
  }
  const vulnerabilities = report.vulnerabilities;
  const counters = report.metadata.vulnerabilities;
  const counterKeys = [...knownSeverities, 'total'];
  if (Object.keys(counters).some((key) => !counterKeys.includes(key))
    || counterKeys.some((key) => !Number.isSafeInteger(counters[key]) || counters[key] < 0)) {
    throw new Error('Invalid audit vulnerability counters');
  }
  if (counters.total !== Object.keys(vulnerabilities).length
    || [...knownSeverities].reduce((sum, severity) => sum + counters[severity], 0) !== counters.total) {
    throw new Error('Audit vulnerability counts do not match the total');
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
    throw new Error('Audit severity counts do not match the package records');
  }
  if (!isObject(allowlist) || allowlist.version !== 1 || !Array.isArray(allowlist.exceptions)) {
    throw new Error('Invalid dependency audit allowlist');
  }
  const seen = new Set();
  for (const entry of allowlist.exceptions) {
    if (!isObject(entry) || !text(entry.package) || !text(entry.range) || !text(entry.reason)
      || !['high', 'critical'].includes(entry.severity) || !Array.isArray(entry.advisoryIds)
      || entry.advisoryIds.length === 0 || entry.advisoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(entry.advisoryIds).size !== entry.advisoryIds.length) {
      throw new Error('Invalid exception: package, range, severity, advisoryIds and reason are required');
    }
    if (date(entry.reviewed) > today || date(entry.expires) <= today || entry.expires <= entry.reviewed) {
      throw new Error(`Expired or invalid exception dates for ${entry.package}`);
    }
    if (seen.has(entry.package)) throw new Error(`Duplicate exception for ${entry.package}`);
    seen.add(entry.package);
  }

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
      const vulnerability = Object.hasOwn(vulnerabilities, current) ? vulnerabilities[current] : undefined;
      if (!isObject(vulnerability) || vulnerability.name !== current
        || !text(vulnerability.range) || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
        throw new Error(`Invalid vulnerability or via reference for ${current}`);
      }
      severities.add(vulnerability.severity);
      for (const via of vulnerability.via) {
        if (typeof via === 'string') {
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
    const severity = unknown ? 'unknown'
      : severities.includes('critical') ? 'critical'
        : severities.includes('high') ? 'high' : vulnerability.severity;
    if (!['high', 'critical', 'unknown'].includes(severity)) {
      result.nonBlocking.push(name);
      continue;
    }
    const exception = allowlist.exceptions.find((entry) => entry.package === name
      && entry.range === vulnerability.range && entry.severity === severity
      && JSON.stringify([...entry.advisoryIds].sort((a, b) => a - b)) === JSON.stringify(ids));
    const finding = { package: name, severity, range: vulnerability.range, advisoryIds: ids };
    if (exception && !unknown) result.allowed.push({ ...finding, expires: exception.expires });
    else result.blocked.push(finding);
  }
  return result;
}

export function runAudit() {
  // No install scripts, node_modules or application/database credentials needed.
  // npm's advisory cache can retain old severity even after an online response.
  // Override inherited config with a fresh, owned cache for every invocation.
  const cache = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), 'deps-audit-cache-'));
  try {
    const guard = fileURLToPath(new URL('./deps-audit-registry.cjs', import.meta.url));
    const audit = spawnSync('npm', ['audit', '--offline=false', `--cache=${cache}`, '--package-lock-only', '--json', '--include=prod', '--include=dev', '--include=optional', '--include=peer'], {
      cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEPS_AUDIT_REGISTRY_GUARD: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(guard)}` },
    });
    if (audit.error || ![0, 1].includes(audit.status)) {
      throw new Error('npm audit did not complete successfully');
    }
    // fd 3 contains only validation state, never registry data or credentials.
    const boundary = JSON.parse(audit.output[3] || 'null');
    if (!isObject(boundary) || boundary.version !== 1 || boundary.valid !== true
      || !Number.isSafeInteger(boundary.responses) || boundary.responses < 1 || boundary.pending !== 0) {
      throw new Error('Registry advisory response was not schema-validated');
    }
    const report = JSON.parse(audit.stdout);
    const allowlist = JSON.parse(readFileSync(new URL('./deps-audit-allowlist.json', import.meta.url), 'utf8'));
    const result = evaluateAudit(report, allowlist);
    // Do not print raw registry responses or stderr; only policy findings.
    console.log(JSON.stringify(result, null, 2));
    if (result.blocked.length > 0) process.exitCode = 1;
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runAudit();
  } catch (error) {
    console.error(`Dependency audit failed: ${error instanceof SyntaxError ? 'Invalid JSON' : error.message}`);
    process.exitCode = 1;
  }
}
