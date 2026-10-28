// Additive size admissions. The JSON fragments are frozen bases, NOT mutable
// counters. Reviewed decision files add bytes; git/GitHub provenance and caps
// are checked separately by check-budget-admissions.mjs, hard on PR and queue.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DECISIONS_DIR = "ci/budgets/decisions";
const ARCHIVES = new Set(["kit-perf", "bundle"]);
const UNIT = /^(kit|bundle|deploy)-[a-z0-9-]+-(raw|gzip)$/;
const DECISION =
  /^ci\/budgets\/decisions\/([^/]+)\/(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const FIELDS = ["unit", "delta_bytes", "before_bytes", "after_bytes", "cause", "pr"];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label}: expected a safe integer >= ${minimum}`);
  }
  return value;
}

function validateRecord(record) {
  if (!record || !UNIT.test(record.unit)) throw new Error("invalid admission unit");
  integer(record.delta_bytes, "delta_bytes");
  integer(record.before_bytes, "before_bytes", 0);
  integer(record.after_bytes, "after_bytes");
  integer(record.pr, "PR");
  if (record.after_bytes <= record.before_bytes)
    throw new Error("admission requires measured growth");
  if (typeof record.cause !== "string" || record.cause.trim().length < 12) {
    throw new Error("admission requires an explained cause and import check");
  }
}

// JSON is a YAML-compatible front-matter mapping. Restrict it to six flat
// fields; canonical serialization also rejects duplicate JSON keys instead
// of silently accepting the last one. The prose body is for review evidence.
export function parseAdmission(file, text) {
  const match = DECISION.exec(file);
  if (!match || !UNIT.test(match[1])) throw new Error(`invalid decision path: ${file}`);
  const date = new Date(`${match[2]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[2]) {
    throw new Error(`invalid decision date: ${file}`);
  }
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!front) throw new Error(`${file}: missing JSON front matter`);
  const data = JSON.parse(front[1]);
  if (
    !data ||
    Array.isArray(data) ||
    typeof data !== "object" ||
    Object.keys(data).sort().join() !== [...FIELDS].sort().join()
  ) {
    throw new Error(`${file}: front matter must contain exactly ${FIELDS.join(", ")}`);
  }
  // Count keys lexically, including escaped spellings, with JSON's own string
  // parser. Values are flat scalars, so every string followed by ':' is a key.
  const keys = [...front[1].matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map((key) => JSON.parse(key[1]));
  if (keys.length !== FIELDS.length || new Set(keys).size !== FIELDS.length) {
    throw new Error(`${file}: duplicate front matter key`);
  }
  validateRecord(data);
  if (data.unit !== match[1]) throw new Error(`${file}: unit does not match directory`);
  return { ...data, file };
}

export function readAdmissions(root) {
  const dir = join(root, DECISIONS_DIR);
  if (!existsSync(dir)) return []; // legacy hermetic fixtures have no ledger
  const records = [];
  for (const unit of readdirSync(dir).sort()) {
    const unitPath = join(dir, unit);
    if (!lstatSync(unitPath).isDirectory()) throw new Error(`invalid decision path: ${unit}`);
    if (ARCHIVES.has(unit)) continue; // frozen legacy prose; never new allowances
    if (!UNIT.test(unit)) throw new Error(`invalid admission unit: ${unit}`);
    for (const name of readdirSync(unitPath).sort()) {
      const file = `${DECISIONS_DIR}/${unit}/${name}`;
      if (!lstatSync(join(root, file)).isFile()) throw new Error(`invalid decision path: ${file}`);
      records.push(parseAdmission(file, readFileSync(join(root, file), "utf8")));
    }
  }
  return records;
}

export function budgetUnits(kind, plan) {
  const units = new Map();
  const walk = (value, path = []) => {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("$")) continue;
      if (["maxRawBytes", "maxGzipBytes"].includes(key)) {
        integer(item, path.join("."));
        const slug = path
          .join("-")
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-");
        const unit = `${kind}-${slug}-${key === "maxRawBytes" ? "raw" : "gzip"}`;
        if (units.has(unit)) throw new Error(`duplicate budget unit identity: ${unit}`);
        units.set(unit, { value: item, path: [...path, key] });
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        walk(item, [...path, key]);
      }
    }
  };
  walk(plan);
  return units;
}

function safeSum(base, delta) {
  return integer(base + delta, "effective ceiling safe integer");
}

export function applyAdmissions(root, kind, plan) {
  const result = structuredClone(plan);
  const units = budgetUnits(kind, result);
  for (const record of readAdmissions(root)) {
    if (!record.unit.startsWith(`${kind}-`)) continue;
    const unit = units.get(record.unit);
    if (!unit) throw new Error(`unknown unit: ${record.unit}`);
    let target = result;
    for (const key of unit.path.slice(0, -1)) target = target[key];
    const key = unit.path.at(-1);
    target[key] = safeSum(target[key], record.delta_bytes);
  }
  return result;
}

// Snapshot maps contain git blob identities (or bytes in tests). Every base
// and every old decision, including prose, is frozen. New assets need a
// separately reviewed initial-allocation policy change, not an in-band delta.
export function validateFrozenFiles(baseFiles, headFiles, initialAllocations = new Set()) {
  for (const [file, contents] of baseFiles) {
    if (!headFiles.has(file) || headFiles.get(file) !== contents) {
      throw new Error(`frozen budget base/history changed or deleted: ${file}`);
    }
  }
  for (const file of headFiles.keys()) {
    if (baseFiles.has(file) || initialAllocations.has(file)) continue;
    if (!file.startsWith(`${DECISIONS_DIR}/`)) {
      throw new Error(`new budget base requires separate initial allocation: ${file}`);
    }
    const match = DECISION.exec(file);
    if (!match || !UNIT.test(match[1]))
      throw new Error(`new decision must be an admission: ${file}`);
  }
}

// Denominators do not compound within a queue batch: every PR uses the
// effective main ceiling at the group's base; the weekly cap uses the
// effective ceiling at (now - 7d). Provenance is supplied by the git/GitHub
// adapter, NEVER from a decision's date, claimed PR or local commit clock.
export function validateAdmissions({ bases, historical, proposed, now }) {
  const clock = Date.parse(now);
  if (!Number.isFinite(clock)) throw new Error("invalid validation clock");
  const seen = new Set();
  const totals = new Map(
    [...bases].map(([unit, base]) => [
      unit,
      {
        current: integer(base, unit),
        weekBase: base,
        recent: 0,
        added: 0,
        byPr: new Map(),
      },
    ]),
  );
  for (const record of [...historical, ...proposed]) {
    validateRecord(record);
    if (seen.has(record.file)) throw new Error(`duplicate decision identity: ${record.file}`);
    seen.add(record.file);
    if (!totals.has(record.unit)) throw new Error(`unknown unit: ${record.unit}`);
  }
  for (const record of historical) {
    const time = Date.parse(record.mergedAt);
    if (!Number.isFinite(time) || time > clock)
      throw new Error(`invalid main merge provenance: ${record.file}`);
    const total = totals.get(record.unit);
    total.current = safeSum(total.current, record.delta_bytes);
    if (time <= clock - WEEK_MS) total.weekBase = safeSum(total.weekBase, record.delta_bytes);
    else total.recent = safeSum(total.recent, record.delta_bytes);
  }
  for (const record of proposed) {
    const total = totals.get(record.unit);
    total.added = safeSum(total.added, record.delta_bytes);
    total.byPr.set(record.pr, safeSum(total.byPr.get(record.pr) ?? 0, record.delta_bytes));
    if (record.before_bytes > total.current)
      throw new Error(`before measurement exceeds current ceiling: ${record.file}`);
  }
  for (const [unit, total] of totals) {
    for (const [pr, delta] of total.byPr) {
      if (BigInt(delta) * 200n > BigInt(total.current)) {
        throw new Error(`${unit}: PR #${pr} aggregate ${delta}B exceeds 0.5% of ${total.current}B`);
      }
    }
    if (
      total.added &&
      (BigInt(total.recent) + BigInt(total.added)) * 50n > BigInt(total.weekBase)
    ) {
      throw new Error(`${unit}: rolling 7-day additions exceed 2% of ${total.weekBase}B`);
    }
  }
  for (const record of proposed) {
    const total = totals.get(record.unit);
    if (record.after_bytes > safeSum(total.current, total.added)) {
      throw new Error(`after measurement is not covered by the admission: ${record.file}`);
    }
  }
  return totals;
}

// Optional target, not a minimum allocation: overage + headroom is ALWAYS
// clipped to floor(0.5% * ceiling). Small assets use byte-scale blocks.
export function admissionHeadroom(ceiling, measured) {
  integer(ceiling, "ceiling");
  integer(measured, "measurement");
  const cap = Math.floor(ceiling / 200);
  const overage = Math.max(0, measured - ceiling);
  if (overage > cap) throw new Error("measurement needs more than the 0.5% allowance");
  const block = cap >= 256 ? Math.floor(cap / 256) * 256 : cap;
  return Math.min(cap, overage + block);
}
