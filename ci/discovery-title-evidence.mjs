import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const afterSha = "b04aa9823e1a87c04284ea8fc20c63099338ac79";
export const states = {
  S1: ["/events?view=calendar&month=2099-05", "Events — May 2099"],
  S2: ["/events?q=Community", "Events matching “Community”"],
  S3: ["/events/past?page=2", "Past events — page 2"],
  S4: ["/events/past?q=Past%20Night", "Past events matching “Past Night”"],
  S5: ["/hotzones?season=2026-02", "Hot zones — 2026-02"],
  S6: ["/hotzones/joins?season=2026-02", "joins hot zone — 2026-02"],
  S7: [`/events/past?q=${"x".repeat(300)}`, "Events — search too long"],
  S8: [`/events?q=${"x".repeat(300)}`, "Events — search too long"],
  I1: ["/events?view=calendar&month=2099-06", "Events — June 2099"],
  I2: ["/events?view=calendar&month=2099-05", "Events — May 2099"],
  I3: ["/events/past?page=2", "Past events — page 2"],
  I4: ["/events/past", "Past events"],
  I5: ["/events/past?page=2", "Past events — page 2"],
};
export const viewports = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function validate(rows, provenance, loadPng) {
  assert.equal(provenance.after, afterSha);
  assert.match(provenance.before, /^[a-f0-9]{40}$/);
  assert.notEqual(provenance.before, provenance.after);
  assert.equal(rows.length, 104, "Exactly 104 matrix cells");
  const expected = new Set();
  for (const identity of ["before", "after"])
    for (const renderer of ["hono", "kit"])
      for (const stateId of Object.keys(states))
        for (const viewport of Object.keys(viewports))
          expected.add(`${identity}/${identity}-${renderer}-${stateId}-${viewport}.png`);
  for (const row of rows) {
    const { identity, renderer, stateId, png } = row;
    const viewport = Object.entries(viewports).find(
      ([, v]) => `${v.width}x${v.height}` === row.viewport,
    )?.[0];
    assert.equal(png, `${identity}/${identity}-${renderer}-${stateId}-${viewport}.png`);
    assert.ok(expected.delete(png), `Unexpected or duplicate cell: ${png}`);
    assert.equal(row.sha, provenance[identity]);
    assert.equal(row.runUrl, provenance.runUrl);
    const url = new URL(row.url);
    const origin = ["S5", "S6"].includes(stateId)
      ? "https://period.example.test"
      : renderer === "hono"
        ? "https://localhost:8787"
        : "http://127.0.0.1:8788";
    assert.equal(url.origin, origin, "Renderer origin must match its label");
    assert.equal(url.pathname + url.search, states[stateId][0]);
    assert.equal(row.httpStatus, ["S7", "S8"].includes(stateId) ? 422 : 200);
    assert.ok(
      row.documentTitle && row.h1 && row.interaction && Number.isFinite(Date.parse(row.capturedAt)),
    );
    if (identity === "after")
      assert.equal(row.documentTitle, `${states[stateId][1]} — Together We Own`);
    if (["S7", "S8"].includes(stateId)) assert.equal(row.h1, "Events");
    if (stateId === "I5")
      assert.equal(row.documentTitle, row.previousTitle, "Failed read preserves title");
    const bytes = loadPng(png);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), viewports[viewport].width);
    assert.ok(bytes.readUInt32BE(20) >= viewports[viewport].height);
    assert.equal(digest(bytes), row.pngSha256);
  }
  assert.equal(expected.size, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve("discovery-title-evidence");
  if (process.argv[2] === "fixtures" || process.argv[2] === "cleanup") {
    const { requireGithubRunner, requireTestDatabase } = await import("../e2e/ci-only.mjs");
    requireGithubRunner();
    const { default: postgres } = await import("postgres");
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      for (let n = 1; n <= 21; n++) {
        const suffix = String(n).padStart(2, "0");
        const key = `01J0000000000000000000E1${suffix}`;
        if (process.argv[2] === "cleanup") await sql`delete from events where event_key = ${key}`;
        else
          await sql`insert into events (event_key,title,description,starts_at,ends_at,timezone,status,capacity,rsvp_open)
          values (${key},${`E2E Evidence Past ${suffix}`},'Disposable evidence fixture',
          ${`2000-01-${suffix}T18:00:00Z`},${`2000-01-${suffix}T20:00:00Z`},'UTC','published',10,true)`;
      }
    } finally {
      await sql.end();
    }
  } else {
    const rowsDir = resolve(directory, "rows");
    const rows = existsSync(rowsDir)
      ? readdirSync(rowsDir)
          .sort()
          .map((name) => JSON.parse(readFileSync(resolve(rowsDir, name), "utf8")))
      : [];
    const manifest = `${JSON.stringify(rows, null, 2)}\n`;
    writeFileSync(resolve(directory, "manifest.json"), manifest);
    writeFileSync(resolve(directory, "manifest.sha256"), `${digest(manifest)}  manifest.json\n`);
    const provenance = JSON.parse(readFileSync(resolve(directory, "provenance.json"), "utf8"));
    const tables = Object.keys(states).map((stateId) => {
      const lines = [`## ${stateId}`, "| Renderer / viewport | Before | After |", "|---|---|---|"];
      for (const renderer of ["hono", "kit"])
        for (const v of Object.values(viewports)) {
          const cells = ["before", "after"].map((identity) => {
            const row = rows.find(
              (r) =>
                r.identity === identity &&
                r.renderer === renderer &&
                r.stateId === stateId &&
                r.viewport === `${v.width}x${v.height}`,
            );
            return row ? `[${row.documentTitle}](${row.png})` : "MISSING";
          });
          lines.push(`| ${renderer} / ${v.width}x${v.height} | ${cells.join(" | ")} |`);
        }
      return lines.join("\n");
    });
    writeFileSync(
      resolve(directory, "summary.md"),
      `# Discovery title evidence\n\nManifest SHA-256: ${digest(manifest)}\n\n${tables.join("\n\n")}\n`,
    );
    validate(rows, provenance, (png) => readFileSync(resolve(directory, png)));
    console.log(`Validated 104 cells; manifest sha256 ${digest(manifest)}`);
  }
}
