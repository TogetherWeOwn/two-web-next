#!/usr/bin/env node
// Compare a route-parity recording against a baseline (docs/kit-parity-gates.md,
// "Pure-Hono route parity goldens").
//
//   node ci/parity/compare.mjs --baseline <dir> --candidate <dir>
//   PARITY_DATABASE_URL=... node --import tsx ci/parity/compare.mjs \
//     --baseline test/fixtures/parity/hono-<sha> --config web/wrangler.staging.jsonc
//
// With --config the candidate is recorded first, from any Worker config.
// Differences listed in the approved-exceptions table of
// docs/kit-parity-gates.md are reported but do not fail; everything else does.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { expandRecording } from "./golden.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXCEPTIONS_DOC = "docs/kit-parity-gates.md";
const START = "<!-- route-parity-exceptions:start -->";
const END = "<!-- route-parity-exceptions:end -->";

/** Rows of the approved-exceptions table: `| \`file#vector\` | \`field\` | reason |`. */
export function parseExceptions(markdown) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${EXCEPTIONS_DOC} is missing the route-parity exceptions markers`);
  }
  const rows = [];
  for (const line of markdown.slice(start + START.length, end).split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5 || !cells[1]?.startsWith("`")) continue;
    const [vector, field, reason] = cells.slice(1, 4).map((cell) => cell.replace(/^`|`$/g, ""));
    if (!reason) throw new Error(`Route-parity exception ${vector} ${field} has no reason`);
    rows.push({ vector, field, reason });
  }
  return rows;
}

const glob = (pattern) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

function excepted(exceptions, key, field) {
  return exceptions.find(
    (row) =>
      glob(row.vector).test(key) &&
      (row.field === "*" || row.field === field || field.startsWith(`${row.field}.`)),
  );
}

export function loadRecording(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".json") && full !== join(dir, "index.json")) {
        const record = JSON.parse(readFileSync(full, "utf8"));
        files.set(
          relative(dir, full)
            .split(sep)
            .join("/")
            .replace(/\.json$/, ""),
          record.vectors,
        );
      }
    }
  };
  walk(dir);
  const index = join(dir, "index.json");
  const { shared } = existsSync(index) ? JSON.parse(readFileSync(index, "utf8")) : {};
  return shared ? expandRecording(files, shared) : files;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level differences between two vector responses. */
export function diffResponse(baseline, candidate) {
  const diffs = [];
  for (const field of [
    "status",
    "route",
    "tailLabel",
    "alerts",
    "outbound",
    "setCookies",
    "repeatStatuses",
  ]) {
    if (!same(baseline[field], candidate[field])) {
      diffs.push({ field, baseline: baseline[field], candidate: candidate[field] });
    }
  }
  const names = new Set([...Object.keys(baseline.headers), ...Object.keys(candidate.headers)]);
  for (const name of [...names].sort()) {
    if (baseline.headers[name] !== candidate.headers[name]) {
      diffs.push({
        field: `headers.${name}`,
        baseline: baseline.headers[name],
        candidate: candidate.headers[name],
      });
    }
  }
  if (!same(baseline.body, candidate.body)) {
    const shapeDiffers = !same(baseline.body.shape, candidate.body.shape);
    diffs.push({
      field: shapeDiffers || !baseline.body.shape ? "body" : "body.sha256",
      baseline: baseline.body,
      candidate: candidate.body,
    });
  }
  return diffs;
}

export function compareRecordings(baseline, candidate, exceptions = []) {
  const failures = [];
  const approved = [];
  const used = new Set();
  const note = (key, diff) => {
    const row = excepted(exceptions, key, diff.field);
    if (row) {
      used.add(row);
      approved.push({ key, ...diff, reason: row.reason });
    } else failures.push({ key, ...diff });
  };
  for (const file of new Set([...baseline.keys(), ...candidate.keys()])) {
    const a = baseline.get(file) ?? {};
    const b = candidate.get(file) ?? {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const key = `${file}#${id}`;
      if (!a[id] || !b[id]) {
        note(key, { field: "missing", baseline: Boolean(a[id]), candidate: Boolean(b[id]) });
        continue;
      }
      for (const diff of diffResponse(a[id].response, b[id].response)) note(key, diff);
    }
  }
  const unused = exceptions.filter((row) => !used.has(row));
  return { failures, approved, unused };
}

const brief = (value) => {
  const text = JSON.stringify(value);
  return text && text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

export function report({ failures, approved, unused }, label, limit = 200) {
  const lines = [
    `route parity ${label}: ${failures.length} difference(s), ${approved.length} approved exception(s)`,
  ];
  for (const diff of failures.slice(0, limit)) {
    lines.push(
      `  DIFF ${diff.key} ${diff.field}: ${brief(diff.baseline)} -> ${brief(diff.candidate)}`,
    );
  }
  if (failures.length > limit) lines.push(`  ... ${failures.length - limit} more`);
  for (const row of unused) lines.push(`  NOTE unused exception ${row.vector} ${row.field}`);
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      config: { type: "string" },
      exceptions: { type: "string", default: EXCEPTIONS_DOC },
    },
  });
  if (!values.baseline || (!values.candidate && !values.config)) {
    throw new Error("usage: --baseline <dir> (--candidate <dir> | --config <wrangler config>)");
  }
  let candidate = values.candidate;
  if (!candidate) {
    const { record } = await import("./record.mjs");
    candidate = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "route-parity-candidate-"));
    await record({
      out: candidate,
      targetConfig: values.config,
      databaseUrl: process.env.PARITY_DATABASE_URL,
    });
  }
  const exceptions = parseExceptions(readFileSync(join(repo, values.exceptions), "utf8"));
  const result = compareRecordings(
    loadRecording(resolve(values.baseline)),
    loadRecording(resolve(candidate)),
    exceptions,
  );
  console.log(report(result, `${values.baseline} vs ${values.config ?? candidate}`));
  process.exitCode = result.failures.length === 0 ? 0 : 1;
}
