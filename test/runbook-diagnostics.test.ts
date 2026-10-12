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

function rowContaining(text: string) {
  const row = rows.find((line) => line.includes(text));
  expect(row, `outage row containing ${text}`).toBeDefined();
  return row!;
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
    expect(health).toContain("healthy + unknown");
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
      /DB-outage failures.*503 HTML.*Other uncaught failures.*500 HTML/,
    );
    expect(outage).toMatch(/public\s+fallback[^.]*not[^.]*private[^.]*writes/i);
  });

  it("cites shipped readiness and documents current outage responses", () => {
    expect(health).toMatch(
      /Readiness shipped in \[#111\]\(https:\/\/github.com\/TogetherWeOwn\/two-web-next\/pull\/111\)/,
    );
    expect(health).not.toMatch(/Pending[^\n]*#111/);
    expect(outage).not.toMatch(/Pending[^\n]*#92|not shipped in this snapshot/);
    expect(routeRow("/events/past")).toMatch(
      /DB-outage failures.*503 HTML.*Events temporarily unavailable/,
    );
    expect(routeRow("/e/:key")).toMatch(
      /DB-outage failures.*503 HTML.*Member data is temporarily unavailable\./,
    );
    expect(routeRow("/profile")).toMatch(
      /GET\/HEAD.*other failures inside the member-read boundary.*503.*Member data is temporarily unavailable/,
    );
    expect(rowContaining("Member save")).toMatch(
      /classified DB outage.*503.*store\.save.*500.*Could not save your profile.*other failures before the write.*503.*Member data is temporarily unavailable/,
    );
    expect(routeRow("/admin")).toMatch(
      /GET\/HEAD.*other failures inside the member-read boundary.*503.*Member data is temporarily unavailable/,
    );
    expect(outage).toMatch(
      /Implemented `\/admin` writes \(POST\)[^\n]*outside the member-read boundary[^\n]*classified DB outage.*503[^\n]*other uncaught failures.*500 HTML/i,
    );
    expect(outage).toMatch(/reads inside the member-read boundary.*member\/admin GET\/HEAD/);
    expect(health).not.toMatch(/curl\s|fetch\(/);
    expect(outage).not.toMatch(/curl\s|fetch\(/);
  });
});
