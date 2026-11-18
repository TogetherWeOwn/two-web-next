// Replay the complete measured client plan. Route-only decisions advance the
// same chain as aggregate decisions; neither can fork or reset the other.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLIENT_FILES, parseDecision, replayDecision } from "./kit-client-ratchet.mjs";
import { ROUTE_BUDGET, targetBytes, validateRouteBudget } from "./kit-route-budget.mjs";

const DECISIONS = "ci/budgets/decisions/kit-perf";
const ADMISSION = /^route-admission-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const KINDS = ["js", "css"];
const AXES = {
  rawBytes: ["maxRawBytes", 512],
  gzipBytes: ["maxGzipBytes", 256],
  files: ["maxFiles", 0],
};
const JOB =
  /^https:\/\/github\.com\/TogetherWeOwn\/two-web-next\/actions\/runs\/[1-9]\d*\/job\/[1-9]\d*$/;
const sortedKeys = (value) => Object.keys(value).sort();

function keys(value, expected) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected object");
  assert.deepEqual(sortedKeys(value), [...expected].sort(), "invalid admission fields");
}

export function clientPlanDigest(approved) {
  const canonical = JSON.stringify(approved, (_, value) =>
    value && typeof value === "object"
      ? Object.fromEntries(sortedKeys(value).map((key) => [key, value[key]]))
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function admissionCeilings(measurement, caps, aggregate) {
  keys(measurement, KINDS);
  const result = {};
  for (const kind of KINDS) {
    const m = measurement[kind];
    keys(m, Object.keys(AXES));
    const ceiling = {};
    for (const [metric, [limit, step]] of Object.entries(AXES)) {
      const n = m[metric];
      const cap = caps[kind][limit];
      assert.ok(Number.isSafeInteger(n) && n >= 0, "invalid admission measurement");
      assert.ok(n <= cap, "admission measurement exceeds current aggregate ceiling");
      if (aggregate) assert.ok(n <= aggregate[kind][metric], "route exceeds measured aggregate");
      ceiling[limit] = Math.min(cap, step ? targetBytes(n, step) : n && n + 1);
    }
    assert.ok(m.files !== 0 || (m.rawBytes === 0 && m.gzipBytes === 0), "nonzero empty group");
    result[kind] = ceiling;
  }
  return result;
}

function parseAdmission(text) {
  const record = JSON.parse(text);
  // A single encoding also rejects duplicate JSON properties before replay.
  assert.equal(text, `${JSON.stringify(record, null, 2)}\n`, "invalid admission JSON encoding");
  keys(record, "version beforeSha256 sourceSha jobUrl reportSha256 aggregate additions".split(" "));
  assert.equal(record.version, 1, "unsupported route admission version");
  for (const sha of [record.beforeSha256, record.reportSha256]) assert.match(sha, /^[a-f0-9]{64}$/);
  assert.match(record.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(record.jobUrl, JOB);
  assert.ok(Array.isArray(record.additions) && record.additions.length, "empty route admission");
  return record;
}

function replayAdmission(record, approved) {
  admissionCeilings(record.aggregate, approved.client);
  const routeBudget = structuredClone(approved.routeBudget);
  for (const addition of record.additions) {
    keys(addition, ["id", "measured", "ceiling"]);
    const { id, measured, ceiling } = addition;
    assert.match(id, /^(?:\/|(?:\/[^/\\\s?#\p{Cc}]+)+)$/u, "invalid admitted route id");
    assert.ok(!/\/\.{1,2}(?:\/|$)/.test(id), "invalid admitted route id");
    assert.ok(!Object.hasOwn(routeBudget.routes, id), "duplicate or already approved route id");
    const expected = admissionCeilings(measured, approved.client, record.aggregate);
    assert.deepEqual(ceiling, expected, "incorrect admission ceiling");
    routeBudget.routes[id] = ceiling;
  }
  return { client: approved.client, routeBudget: validateRouteBudget(routeBudget) };
}

export const INITIAL_CLIENT_BUDGET = {
  js: { maxRawBytes: 261632, maxGzipBytes: 104448, maxFiles: 55 },
  // CSS raw 3584: ci/budgets/decisions/kit-perf/2026-11-11-admin-validation-css-raw.md
  css: { maxRawBytes: 3584, maxGzipBytes: 1280, maxFiles: 4 },
};
export const INITIAL_ROUTE_DECISION =
  "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md";
const plan = (files) => ({
  client: {
    js: files[CLIENT_FILES[0]].client.js,
    css: files[CLIENT_FILES[1]].client.css,
  },
  routeBudget: validateRouteBudget(files[ROUTE_BUDGET]),
});

function readDecision(root, path) {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), "symlink decision evidence");
  }
  const stat = lstatSync(current);
  assert.ok(
    stat.isFile() && stat.size <= 2 * 1024 * 1024,
    "invalid or oversized decision evidence",
  );
  return readFileSync(current, "utf8");
}

export function initialRouteBudget(root) {
  const text = readDecision(root, INITIAL_ROUTE_DECISION);
  const matches = [...text.matchAll(/## Initial approved route plan\n\n```json\n([\s\S]*?)\n```/g)];
  assert.equal(matches.length, 1, "missing or ambiguous initial approved route plan");
  return validateRouteBudget(JSON.parse(matches[0][1]));
}

export function approvedClientPlan(root) {
  const pending = [];
  for (const name of readdirSync(join(root, DECISIONS)).sort()) {
    if (name.startsWith("route-admission-")) {
      assert.ok(ADMISSION.test(name), "invalid route admission filename");
      pending.push({ admission: parseAdmission(readDecision(root, `${DECISIONS}/${name}`)) });
    } else if (/^auto-client-ratchet-[a-f0-9]{12}\.md$/.test(name)) {
      const evidence = parseDecision(readDecision(root, `${DECISIONS}/${name}`));
      pending.push({ before: plan(evidence.base), after: plan(replayDecision(evidence).files) });
    }
  }
  let approved = {
    client: structuredClone(INITIAL_CLIENT_BUDGET),
    routeBudget: initialRouteBudget(root),
  };
  while (pending.length) {
    const digest = clientPlanDigest(approved);
    const matches = pending.filter((record) =>
      record.admission
        ? record.admission.beforeSha256 === digest
        : isDeepStrictEqual(record.before, approved),
    );
    assert.equal(matches.length, 1, "expected one successor in the approved ceiling chain");
    const [record] = matches;
    pending.splice(pending.indexOf(record), 1);
    approved = record.admission ? replayAdmission(record.admission, approved) : record.after;
  }
  return approved;
}

export const approvedClientBudget = (root) => approvedClientPlan(root).client;
export const approvedRouteBudget = (root) => approvedClientPlan(root).routeBudget;
