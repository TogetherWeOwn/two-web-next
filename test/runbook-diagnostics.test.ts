import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Offline documentation drift checks; runtime behavior has its own route fixtures.
const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
const deploy = runbook
  .split("## Deploy and record the rollback pointer")[1]!
  .split("### Worker rollback")[0]!;
const health = runbook
  .split("## Read `/up` without mistaking liveness for readiness")[1]!
  .split("## Neon / Hyperdrive outage behavior")[0]!;
const outage = runbook
  .split("## Neon / Hyperdrive outage behavior")[1]!
  .split("## Queue containment, drain and failed-job replay")[0]!;
const rows = outage.split("\n").filter((line) => line.startsWith("| "));
const retired = ["/health", "/healthz", "/db-ping"];

function routeRow(path: string) {
  const row = rows.find((line) => line.split("|")[1]!.includes(`\`${path}\``));
  expect(row, `outage row for ${path}`).toBeDefined();
  return row!;
}

// Offline semantic guard for the run-owned full-suite contract. It flags the
// stale shared-database instruction in either corrected passage and requires
// the fresh run-owned contract with its canonical link and tier distinction.
// Scoped to full-suite wording so focused isolated-schema fixtures that name
// the shared database (restore drill, queue inspection) do not trip it.
function contractViolations(doc: string): string[] {
  const violations: string[] = [];
  if (/Tests use `agent-testdb`, database `two_web_next`/.test(doc)) {
    violations.push("stale safety passage directs full verification to shared two_web_next");
  }
  if (
    /Full database verification must explicitly use\s+`postgres:\/\/agent_test@agent-testdb:5432\/two_web_next`/.test(
      doc,
    )
  ) {
    violations.push("stale full-check passage directs full verification to shared two_web_next");
  }
  if (!/fresh, run-owned[\s\S]*`two_web_next_tog<[^`]+>`/.test(doc)) {
    violations.push("missing fresh run-owned two_web_next_tog<digits> requirement");
  }
  if (!/never the shared\s+`two_web_next`/.test(doc)) {
    violations.push("missing refusal of the shared two_web_next database for full verification");
  }
  if (!/README\.md#database-and-migrations/.test(doc)) {
    violations.push("missing link to the canonical README database setup");
  }
  if (!/Fixture-only `npm run check:offline` is limited evidence/.test(doc)) {
    violations.push("missing fixture-only check:offline limited-evidence distinction");
  }
  if (!/focused isolated-schema tests remain\s+allowed/.test(doc)) {
    violations.push("missing focused isolated-schema allowance");
  }
  return violations;
}

describe("runbook diagnostic and homepage contract", () => {
  it("documents the deployed public-route smoke, not removed diagnostic probes", () => {
    expect(deploy).toMatch(/node bin\/smoke\.mjs https:\/\/next\.togetherweown\.com/);
    for (const path of retired) expect(deploy).not.toContain(`\`${path}\``);
    const workflow = readFileSync(
      new URL("../.github/workflows/deploy.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("node bin/smoke.mjs https://next.togetherweown.com");
  });

  it("explicitly retires all removed routes instead of listing them as outage diagnostics", () => {
    const retirement = health
      .split("\n\n")
      .find((paragraph) => retired.every((path) => paragraph.includes(`\`${path}\``)));
    expect(retirement).toMatch(/retired[\s\S]*404/);
    for (const path of retired) {
      // An outage-table row may list them, but only as ordinary 404s.
      for (const row of rows.filter((line) => line.split("|")[1]!.includes(`\`${path}\``))) {
        expect(row).toMatch(/\*\*404\*\*/);
        expect(row).not.toMatch(/\b(200|503)\b/);
      }
    }
  });

  it("documents shipped /up readiness separately from DB-free startup and queue evidence", () => {
    expect(health).toMatch(/`GET \/up` is \*\*readiness\*\*/);
    expect(health).not.toMatch(/always returns \*\*200\*\*/);
    expect(health).toMatch(/`GET \/robots\.txt` is DB-free[^.]*startup/);
    expect(health).toContain("HTTP 200 + `db:ok` + `pending_migrations:0`");
    expect(health).toContain("degraded + unknown");
    expect(health).toContain("lack of evidence");
    expect(health).toContain("oldest_ready_wait_age_seconds");
    expect(health).toContain("ready_wait_severity");
    expect(health).toContain("ledger eligibility age");
    expect(health).toContain("not proof of domain-claim eligibility");
    expect(health).toContain("strictly >1800 s");
    expect(routeRow("/up")).toMatch(/\*\*503\*\* `db:error`, `pending_migrations:null`.*`unknown`/);
  });

  it("distinguishes the guest homepage fallback from unavailable private writes", () => {
    const home = routeRow("/");
    expect(home).toMatch(/\*\*200\*\*.*guest/);
    expect(home).not.toMatch(/500|Not guaranteed/);
    expect(home).toMatch(/counts.*events.*featured/i);
    expect(routeRow("/events/past")).toMatch(
      /Classified DB outages.*503.*missing event DB.*plain-text.*503.*other uncaught failures.*500 HTML/i,
    );
    expect(routeRow("/e/:key")).toMatch(
      /missing event DB.*plain-text.*503.*other failed reads.*plain-text.*503/,
    );
    expect(outage).toMatch(/public\s+fallback[^.]*not[^.]*private[^.]*writes/i);
  });

  it("cites shipped readiness and documents current outage responses", () => {
    expect(health).toMatch(
      /Readiness shipped in \[#111\]\(https:\/\/github.com\/TogetherWeOwn\/two-web-next\/pull\/111\)/,
    );
    expect(health).not.toMatch(/Pending[^\n]*#111/);
    expect(outage).not.toMatch(/Pending[^\n]*#92|not shipped in this snapshot/);
    expect(routeRow("/events/past")).toMatch(/Classified DB outages.*503/);
    expect(routeRow("/join/discord")).toMatch(
      /classified DB outage.*503.*other uncaught join-store, attempt or session errors.*500/i,
    );
    expect(routeRow("/profile")).toMatch(
      /member-data read failures.*503.*other save failures.*500/,
    );
    expect(routeRow("/admin")).toMatch(
      /admin reads.*503.*other uncaught admin-write failures.*500/i,
    );
    const watch = readFileSync(new URL("../docs/48h-watch-spec.md", import.meta.url), "utf8");
    expect(watch).not.toMatch(/uncaught DB failure is 500 HTML/);
    const watchRow = (route: string) => {
      const row = watch.split("\n").find((line) => line.startsWith(`| ${route} |`));
      expect(row, `watch-spec row for ${route}`).toBeDefined();
      return row!;
    };
    expect(watchRow("M member writes")).toMatch(
      /classified DB outage and profile read failure 503.*other session, transaction or save failure 500/,
    );
    expect(watchRow("A privileged")).toMatch(
      /admin reads.*classified DB outage 503.*other uncaught admin-write failure 500/,
    );
    expect(health).not.toMatch(/curl\s|fetch\(/);
    expect(outage).not.toMatch(/curl\s|fetch\(/);
  });

  it("reconciles the withdrawn freeze across the watch companions", () => {
    const watch = readFileSync(new URL("../docs/48h-watch-spec.md", import.meta.url), "utf8");
    const record = readFileSync(new URL("../docs/watch-run-record.md", import.meta.url), "utf8");
    const rollback = readFileSync(new URL("../docs/cutover-rollback.md", import.meta.url), "utf8");
    for (const [name, text] of [
      ["48h-watch-spec.md", watch],
      ["watch-run-record.md", record],
      ["cutover-rollback.md", rollback],
    ] as const) {
      expect(text, `${name} still imposes the freeze`).not.toContain("stays in force");
      expect(text, `${name} still auto-lifts`).not.toContain("lifts the freeze there");
      expect(text, `${name} misses the declaration rule`).toMatch(
        /any future\s+freeze needs a\s+separate declaration/i,
      );
      expect(text, `${name} misses no-auto-lift`).toMatch(
        /watch exit alone does not lift a freeze|never by watch exit alone/i,
      );
    }
    expect(rollback).toMatch(/writer holds[\s\S]*identified before import/i);
  });

  it("observes production with the config-derived app and Tail workers", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const production = wrangler.split('"production"')[1]!;
    const app = production.match(/"name":\s*"([^"]+)"/)![1]!;
    const tail = production.match(/"tail_consumers":\s*\[\s*\{\s*"service":\s*"([^"]+)"/)![1]!;
    expect(app).toBe("two-web-next-production");
    expect(tail).toBe("two-web-next-alerts-production");
    const watch = readFileSync(new URL("../docs/48h-watch-spec.md", import.meta.url), "utf8");
    expect(watch).toContain(`npx wrangler tail ${app}`);
    expect(watch).toContain(`npx wrangler tail ${tail}`);
    expect(watch).toMatch(/Staging comparison only.*`two-web-next`/s);
    expect(watch).toMatch(/As printed it filters staging[\s\S]*for production substitute/i);
    expect(watch).toMatch(new RegExp(`for production substitute[\\s\\S]*\`${app}\``, "i"));
  });

  it("directs full database verification to a fresh run-owned database, not the shared one", () => {
    expect(contractViolations(runbook)).toEqual([]);
    // Both corrected passages link the canonical setup instead of a competing recipe.
    expect(runbook).toContain("README.md#database-and-migrations");
    // Full-suite tier requires a fresh run-owned disposable database ...
    expect(runbook).toMatch(/fresh, run-owned[\s\S]*`two_web_next_tog<[^`]+>`/);
    // ... and explicitly refuses the shared database for that tier ...
    expect(runbook).toMatch(/never the shared\s+`two_web_next`/);
    // ... while keeping the other tiers: fixture-only offline is limited
    // evidence, and focused isolated-schema tests stay allowed.
    expect(runbook).toMatch(/Fixture-only `npm run check:offline` is limited evidence/);
    expect(runbook).toMatch(/focused isolated-schema tests remain\s+allowed/);
    // The guard is scoped to the full-suite instruction: focused fixtures that
    // name the shared database for an isolated schema (restore drill, queue
    // inspection) remain in the document and must not trip it.
    expect(runbook).toContain("PGDATABASE=two_web_next");
  });

  it("rejects a synthetic restoration of the shared-database full-suite instruction", () => {
    const staleSafety =
      "Never test, probe or verify database behavior against staging or production " +
      "databases. Tests use `agent-testdb`, database `two_web_next`, or local fixtures;";
    const staleFull =
      "Full database verification must explicitly use " +
      "`postgres://agent_test@agent-testdb:5432/two_web_next` and the migrated schema, " +
      "never a live service.";
    expect(contractViolations(staleSafety)).not.toEqual([]);
    expect(contractViolations(staleFull)).not.toEqual([]);
    expect(contractViolations(`${staleSafety}\n${staleFull}`)).not.toEqual([]);
    // A fixed document passes again: the guard tracks the contract, not a
    // blocklist of the fixture strings.
    const repaired =
      "Full database verification uses a fresh, run-owned disposable " +
      "database (`two_web_next_tog<digits>`) on `agent-testdb` with the migrated " +
      "schema; follow the canonical setup in " +
      "[README Database and migrations](../README.md#database-and-migrations). " +
      "Full database verification must use a fresh, run-owned `two_web_next_tog<digits>` " +
      "database on `agent-testdb` with the migrated schema, never the shared " +
      "`two_web_next` database nor a live service. " +
      "Fixture-only `npm run check:offline` is limited evidence, not database " +
      "acceptance, and focused isolated-schema tests remain allowed.";
    expect(contractViolations(repaired)).toEqual([]);
  });

  it("smokes the apex with --allow-indexable over the 24-route set", () => {
    const watch = readFileSync(new URL("../docs/48h-watch-spec.md", import.meta.url), "utf8");
    expect(watch).toContain("node bin/smoke.mjs https://togetherweown.com --allow-indexable");
    expect(watch).toMatch(/Twenty-four public routes/s);
    expect(watch).toMatch(/Without `--allow-indexable` the apex probe fails/s);
    expect(watch).toContain("node bin/smoke.mjs https://next.togetherweown.com");
    const smokeTests = readFileSync(new URL("./smoke.test.mjs", import.meta.url), "utf8");
    expect(smokeTests).toContain("allowIndexable rejects a staging noindex leaked onto apex HTML");
  });
});
