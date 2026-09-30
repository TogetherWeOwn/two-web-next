import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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
  if (report.metadata.vulnerabilities.total !== Object.keys(vulnerabilities).length) {
    throw new Error('Audit vulnerability count does not match the report');
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
  function advisories(name, path = new Set()) {
    const vulnerability = vulnerabilities[name];
    if (path.has(name) || !isObject(vulnerability) || vulnerability.name !== name
      || !text(vulnerability.range) || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
      throw new Error(`Invalid vulnerability or cyclic via reference for ${name}`);
    }
    const ids = new Set();
    const severities = [vulnerability.severity];
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        const nested = advisories(via, new Set([...path, name]));
        nested.ids.forEach((id) => ids.add(id));
        severities.push(...nested.severities);
      } else if (isObject(via) && Number.isSafeInteger(via.source) && via.source > 0) {
        ids.add(via.source);
        severities.push(via.severity);
      } else {
        throw new Error(`Invalid advisory for ${name}`);
      }
    }
    return { ids: [...ids].sort((a, b) => a - b), severities };
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
  const audit = spawnSync('npm', ['audit', '--package-lock-only', '--json', '--include=prod', '--include=dev', '--include=optional', '--include=peer'], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (audit.error || ![0, 1].includes(audit.status)) {
    throw new Error('npm audit did not complete successfully');
  }
  const report = JSON.parse(audit.stdout);
  const allowlist = JSON.parse(readFileSync(new URL('./deps-audit-allowlist.json', import.meta.url), 'utf8'));
  const result = evaluateAudit(report, allowlist);
  // Do not print raw registry responses or stderr; only policy findings.
  console.log(JSON.stringify(result, null, 2));
  if (result.blocked.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runAudit();
  } catch (error) {
    console.error(`Dependency audit failed: ${error instanceof SyntaxError ? 'Invalid JSON' : error.message}`);
    process.exitCode = 1;
  }
}
