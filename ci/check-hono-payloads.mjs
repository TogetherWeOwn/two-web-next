// The acceptance table owns public routes and stable IDs; never copy that table.
// Like the Kit gate, run hostile fixtures and fail closed on unmapped/vacuous
// results. The calling-gate assertion is excluded in the child to avoid recursion.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const SUITE = "test/hono-no-member-data-contract.test.ts";
const COVERAGE_SUITE = "test/hono-payload-gate.test.mjs";
const GATE_GROUP = "S7 agent-runnable gate";
const SUPPORT = [
  "no-member-data detector",
  "member-gated negative controls",
  "Hono payload coverage",
];

// Read TypeScript literals through the existing Babel parser, never eval.
export function publicRows(source = readFileSync(join(ROOT, SUITE), "utf8")) {
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const declarations = file.program.body
    .filter((s) => s.type === "VariableDeclaration")
    .flatMap((s) => s.declarations)
    .filter((d) => d.id.type === "Identifier" && d.id.name === "PUBLIC_HONO_GETS");
  const table = declarations[0]?.init;
  if (declarations.length !== 1 || table?.type !== "ArrayExpression") {
    throw new Error("PUBLIC_HONO_GETS must be one literal array");
  }
  const rows = table.elements.map((element) => {
    if (element?.type !== "ObjectExpression") throw new Error("nonliteral route row");
    const row = {};
    for (const p of element.properties) {
      if (
        p.type !== "ObjectProperty" ||
        p.computed ||
        p.key.type !== "Identifier" ||
        p.value.type !== "StringLiteral"
      ) {
        throw new Error("nonliteral route field");
      }
      if (Object.hasOwn(row, p.key.name)) throw new Error("duplicate route field");
      row[p.key.name] = p.value.value;
    }
    if (
      !/^hono-payload:[a-z0-9-]+$/.test(row.id) ||
      row.method !== "GET" ||
      !row.route?.startsWith("/") ||
      !["payload", "redirect"].includes(row.kind)
    ) {
      throw new Error("invalid public route row");
    }
    return row;
  });
  if (
    rows.length === 0 ||
    new Set(rows.map((r) => r.id)).size !== rows.length ||
    new Set(rows.map((r) => r.route)).size !== rows.length
  )
    throw new Error("empty or duplicate routes");
  return rows;
}

// These non-content GETs have separate contracts. Auth deliberately issues
// session/state artifacts; applying the public-content prohibition there would
// break sign-in. Health uses an independent DB client (test/up.test.ts); deploy identity
// answers a fixed five-field allowlist.
export const EXCLUSIONS = {
  "/auth/discord": "OAuth initiation: test/auth-acceptance.test.ts",
  "/auth/discord/redirect": "OAuth alias: test/auth-acceptance.test.ts",
  "/auth/discord/callback": "OAuth callback: test/auth-acceptance.test.ts",
  "/auth/recover": "Session recovery: test/session-recovery.test.ts",
  "/auth/status": "Session status: test/session-recovery.test.ts",
  "/join/discord": "Join OAuth initiation: test/join.test.ts",
  "/join/callback": "Join OAuth callback: test/join.test.ts",
  "/up": "Operational readiness: test/up.test.ts",
  "/readyz": "Deploy identity allowlist: test/web-deploy-identity-acceptance.test.ts",
  "/version": "Deploy identity allowlist: test/web-deploy-identity-acceptance.test.ts",
};
export const AUXILIARY_GETS = ["/.well-known/security.txt", "/members", "/members/"];
const GATED_LABELS = new Set([
  "member",
  "session",
  "moderator",
  "staging-operator",
  "evidence-bearer",
]);
// Reuse exact reviewed registrations, not a blanket /admin or auth-label exemption.
const REVIEWED_GATED = new Map(
  JSON.parse(readFileSync(join(ROOT, "test/fixtures/route-inventory.json"), "utf8"))
    .filter((r) => r.method === "GET" && GATED_LABELS.has(r.auth))
    .map((r) => [r.path, r.auth]),
);
const SHARED_GROUPS = new Set([
  "Hono public JSON API anonymous payloads",
  "Hono static-leaf anonymous payloads",
  "Hono static discovery anonymous payloads",
  "Hono feed anonymous payloads",
  "Hono vanity-redirect anonymous GETs",
]);

export function auditCoverage(inventory, rows) {
  const registration = (route) => {
    if (route === "/e/:key.md") return "/e/:file{.+\\.md}";
    if (route === "/events/:key.ics") return "/events/:file{.+\\.ics}";
    if (["/hotzones/joins", "/hotzones/voice", "/hotzones/games"].includes(route))
      return "/hotzones/:signal";
    return route;
  };
  const publicPaths = new Set(rows.map((r) => registration(r.route)));
  const covered = new Set([...publicPaths, ...AUXILIARY_GETS, ...Object.keys(EXCLUSIONS)]);
  const gets = inventory.filter((r) => r.method === "GET");
  return {
    unlisted: gets
      .filter((r) => !covered.has(r.path) && REVIEWED_GATED.get(r.path) !== r.auth)
      .map((r) => r.path),
    stale: [...covered, ...REVIEWED_GATED.keys()].filter(
      (path) => !gets.some((r) => r.path === path),
    ),
    publicBecameGated: gets
      .filter((r) => publicPaths.has(r.path) && GATED_LABELS.has(r.auth))
      .map((r) => r.path),
  };
}

export function routeForAssertion(rows, assertion) {
  const group = assertion.ancestorTitles?.[0];
  const title = assertion.title ?? "";
  const hits = rows.filter(
    (row) =>
      group === `Hono GET ${row.route} anonymous payload` ||
      (SHARED_GROUPS.has(group) && title.startsWith(`GET ${row.route} `)) ||
      (group === "Hono GET /hotzones/:signal anonymous payloads" &&
        row.route.startsWith("/hotzones/") &&
        title.startsWith(`${row.route.slice(10)} `)),
  );
  return hits.length === 1 ? hits[0].id : null;
}

export function summarize(rows, report) {
  const assertions = (report.testResults ?? []).flatMap((r) => r.assertionResults ?? []);
  const buckets = new Map([...rows.map((r) => r.id), ...SUPPORT].map((id) => [id, []]));
  const unmapped = [];
  let gateExcluded = 0;
  for (const assertion of assertions) {
    const group = assertion.ancestorTitles?.[0];
    // Vitest reports the deliberately unselected calling-gate test as pending.
    if (group === GATE_GROUP && ["pending", "skipped"].includes(assertion.status)) {
      gateExcluded += 1;
      continue;
    }
    const id = SUPPORT.includes(group) ? group : routeForAssertion(rows, assertion);
    if (!id || !buckets.has(id)) unmapped.push(assertion.fullName ?? assertion.title);
    else buckets.get(id).push(assertion.status);
  }
  const result = (id) => {
    const statuses = buckets.get(id);
    return {
      status:
        statuses.length === 0 ? "vacuous" : statuses.every((s) => s === "passed") ? "pass" : "fail",
      tests: statuses.length,
    };
  };
  const checks = rows.map((row) => ({ id: row.id, route: row.route, ...result(row.id) }));
  const controls = SUPPORT.map((id) => ({ id, ...result(id) }));
  const ok =
    report.success === true &&
    gateExcluded === 1 &&
    unmapped.length === 0 &&
    [...checks, ...controls].every((c) => c.status === "pass");
  return { ok, checks, controls, gateExcluded, unmapped };
}

export function summarizeRun(rows, run, report) {
  const summary = summarize(rows, report);
  return {
    check: "hono-payloads",
    ...summary,
    ok: run.status === 0 && !run.error && !run.signal && summary.ok,
    exitCode: run.status,
  };
}

export function runGate() {
  const rows = publicRows();
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "hono-payloads-"),
  );
  const outputFile = join(scratch, "vitest.json");
  try {
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        SUITE,
        COVERAGE_SUITE,
        "-t",
        "^(?:no-member-data detector|Hono |member-gated negative controls)",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return summarizeRun(rows, run, JSON.parse(readFileSync(outputFile, "utf8")));
  } catch (error) {
    return {
      ...summarizeRun(rows, { status: null }, {}),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Only the unique directory created by this invocation, never a supplied path.
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!["", "--format json"].includes(process.argv.slice(2).join(" "))) {
      throw new Error("Usage: node ci/check-hono-payloads.mjs [--format json]");
    }
    const report = runGate();
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `hono-payloads: ${report.ok ? "ok" : "FAIL"} (${report.checks.length} public checks)`,
    );
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        check: "hono-payloads",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
