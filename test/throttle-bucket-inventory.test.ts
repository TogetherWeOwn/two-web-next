// Throttle bucket inventory: pins every human-route throttle bucket name to
// its registration files so a move without a docs+test update fails loudly.
// Static scan only, DB-free. Covers stale file pointers in
// docs/throttling.md (logout/event-write/qa-login), the missing admin-write
// row, the RSVP contracts move, and the MCP cap-before-throttle order.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "src");
const throttlingDoc = readFileSync(resolve(root, "docs/throttling.md"), "utf8");
const bodyLimitsDoc = readFileSync(resolve(root, "docs/body-limits.md"), "utf8");

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

// Middleware registrations: throttle("bucket", N). Excludes src/throttle.ts
// itself (definition + doc comment example).
function middlewareBuckets(): Map<string, { file: string; count: number }[]> {
  const byBucket = new Map<string, Map<string, number>>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    if (rel === "src/throttle.ts") continue;
    const text = stripComments(readFileSync(full, "utf8"));
    for (const match of text.matchAll(/\bthrottle\(\s*"([^"]+)"\s*,/g)) {
      const bucket = match[1]!;
      if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
      const perFile = byBucket.get(bucket)!;
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
    }
  }
  const out = new Map<string, { file: string; count: number }[]>();
  for (const [bucket, perFile] of byBucket) {
    out.set(
      bucket,
      [...perFile]
        .map(([file, count]) => ({ file, count }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    );
  }
  return out;
}

// In-handler guards: throttleGuard(c, "bucket", N). The definition in
// src/throttle.ts takes a variable name, so it never matches.
function guardBuckets(): Map<string, string[]> {
  const byBucket = new Map<string, Set<string>>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    const text = stripComments(readFileSync(full, "utf8"));
    for (const match of text.matchAll(/\bthrottleGuard\(\s*c\s*,\s*"([^"]+)"\s*,/g)) {
      const bucket = match[1]!;
      if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
      byBucket.get(bucket)!.add(rel);
    }
  }
  const out = new Map<string, string[]>();
  for (const [bucket, files] of byBucket) out.set(bucket, [...files].sort());
  return out;
}

// Call sites the literal scanners above cannot see: every throttle(/throttleGuard(
// occurrence whose bucket is not a string literal (or whose guard context is not
// `c`). A const-form or renamed-context registration lands here and fails the
// pins test until it is hand-pinned with a dedicated assertion, so new buckets
// cannot silently escape the inventory (precedent: JOIN_THROTTLE_BUCKET in
// src/join/service.ts). src/throttle.ts is excluded: it holds the definitions
// and the middleware's internal throttleGuard(c, name, max) delegation.
function nonLiteralThrottleSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    if (rel === "src/throttle.ts") continue;
    const text = stripComments(readFileSync(full, "utf8"));
    for (const call of text.matchAll(/\bthrottle\(/g)) {
      if (!/^throttle\(\s*"[^"]+"\s*,/.test(text.slice(call.index))) {
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function nonLiteralGuardSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    if (rel === "src/throttle.ts") continue;
    const text = stripComments(readFileSync(full, "utf8"));
    for (const call of text.matchAll(/\bthrottleGuard\(/g)) {
      if (!/^throttleGuard\(\s*c\s*,\s*"[^"]+"\s*,/.test(text.slice(call.index))) {
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe("throttle bucket inventory", () => {
  it("pins middleware buckets to their registration files and counts", () => {
    const found = middlewareBuckets();
    const expected = new Map<string, { file: string; count: number }[]>([
      ["admin-write", [{ file: "src/admin/routes.tsx", count: 7 }]],
      ["event-write", [{ file: "src/events/routes-writes.ts", count: 3 }]],
      ["logout", [{ file: "src/auth/routes.ts", count: 1 }]],
      ["qa-login", [{ file: "src/auth/routes.ts", count: 1 }]],
      ["alert-probe", [{ file: "src/alert-probe.ts", count: 1 }]],
    ]);
    expect([...found.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [bucket, sites] of expected) {
      expect(found.get(bucket), `bucket ${bucket}`).toEqual(sites);
    }
  });

  it("pins in-handler guard buckets to their call sites", () => {
    const found = guardBuckets();
    expect([...found.keys()].sort()).toEqual(["events-read", "login-callback", "login-redirect"]);
    expect(found.get("login-redirect")).toEqual(["src/auth/routes.ts"]);
    expect(found.get("login-callback")).toEqual(["src/auth/routes.ts"]);
    expect(found.get("events-read")).toEqual(["src/events/routes-shared.ts"]);
  });

  it("fails loudly on non-literal throttle registrations", () => {
    // src/profiles/routes-admission.ts holds the only two: the local admitWrite
    // helper call throttle(c, `profile-write:${viewer.id}`) and the
    // deps.throttle(bucket) seam delegation. Neither is the src/throttle.ts
    // middleware; the profile-write bucket itself is pinned by the dedicated
    // assertion below. Any new entry here is a bucket escaping the literal
    // inventory: hand-pin it and cover it, or make it literal.
    expect(Object.fromEntries(nonLiteralThrottleSites())).toEqual({
      "src/profiles/routes-admission.ts": 2,
    });
    expect(Object.fromEntries(nonLiteralGuardSites())).toEqual({});
  });

  it("pins join, profile-write and rsvp-write buckets to their call sites", () => {
    const service = stripComments(readFileSync(resolve(root, "src/join/service.ts"), "utf8"));
    expect(service).toContain('JOIN_THROTTLE_BUCKET = "join"');
    const routeShared = stripComments(
      readFileSync(resolve(root, "src/join/route-shared.ts"), "utf8"),
    );
    expect(routeShared).toContain("${JOIN_THROTTLE_BUCKET}:");
    const admission = stripComments(
      readFileSync(resolve(root, "src/profiles/routes-admission.ts"), "utf8"),
    );
    expect(admission).toContain("profile-write:${viewer.id}");
    const rsvp = stripComments(readFileSync(resolve(root, "src/events/rsvp.ts"), "utf8"));
    expect(rsvp.match(/rsvp-write:/g)?.length).toBe(3);
  });

  it("documents every bucket in docs/throttling.md with live file pointers", () => {
    // Discovered buckets: a new registration whose pins were updated but whose
    // docs row was forgotten fails here. The hard-coded list below stays as the
    // canonical inventory of documented buckets.
    for (const bucket of [
      ...middlewareBuckets().keys(),
      ...guardBuckets().keys(),
      "join",
      "profile-write",
      "rsvp-write",
    ]) {
      expect(throttlingDoc, `docs mention discovered bucket ${bucket}`).toContain(bucket);
    }
    for (const bucket of [
      "login-redirect",
      "login-callback",
      "qa-login",
      "alert-probe",
      "join",
      "logout",
      "event-write",
      "admin-write",
      "profile-write",
      "events-read",
      "rsvp-write",
    ]) {
      expect(throttlingDoc, `docs mention ${bucket}`).toContain(bucket);
    }
    for (const file of [
      "src/auth/routes.ts",
      "src/alert-probe.ts",
      "src/join/service.ts",
      "src/join/route-shared.ts",
      "src/events/routes-writes.ts",
      "src/admin/routes.tsx",
      "src/profiles/routes-admission.ts",
      "src/events/routes-shared.ts",
      "src/public-data/routes.ts",
      "src/mcp/routes.ts",
      "src/events/rsvp.ts",
      "src/islands/contracts-rsvp-button.ts",
    ]) {
      expect(throttlingDoc, `docs point at ${file}`).toContain(file);
    }
    // Stale pointers from the pre-split layout must not return.
    expect(throttlingDoc).not.toContain("src/index.tsx");
    expect(throttlingDoc).not.toContain("src/events/routes.tsx");
    expect(throttlingDoc).not.toContain("src/islands/contracts.ts");
    // Admin-write row lists its routes and the shared-budget implication.
    expect(throttlingDoc).toContain("POST /admin/featured");
    expect(throttlingDoc).toContain("POST /admin/events");
    expect(throttlingDoc).toContain("POST /admin/queue/failed/:id/redispatch");
  });

  it("pins each bucket to its registration file in its own table row", () => {
    // Row-scoped association: whole-document co-occurrence would let any row
    // point at any already-mentioned file, so each bucket's table row must name
    // the file holding that bucket's registration. Expected files come from the
    // same scanned maps as the pins tests (plus the hand-pinned buckets) so
    // code, pins and docs cannot drift in pairs.
    const bucketFiles = new Map<string, string[]>([
      ["join", ["src/join/service.ts", "src/join/route-shared.ts"]],
      ["profile-write", ["src/profiles/routes-admission.ts", "src/profiles/routes-writes.tsx"]],
      ["rsvp-write", ["src/events/rsvp.ts"]],
    ]);
    for (const [bucket, sites] of middlewareBuckets()) {
      bucketFiles.set(
        bucket,
        sites.map((s) => s.file),
      );
    }
    for (const [bucket, files] of guardBuckets()) {
      bucketFiles.set(bucket, files);
    }
    const rows = throttlingDoc.split("\n").filter((line) => line.startsWith("|"));
    for (const [bucket, files] of bucketFiles) {
      const hits = rows.filter((row) => row.includes(`\`${bucket}`));
      expect(hits.length, `docs table rows mentioning \`${bucket}`).toBeGreaterThan(0);
      for (const row of hits) {
        for (const file of files) {
          expect(row, `\`${bucket}\` row points at ${file}`).toContain(file);
        }
      }
    }
    // Multi-bucket rows need clause-level pins: the Auth and Write rows each
    // name two registration files, so row scope alone cannot say which bucket
    // belongs to which file.
    for (const clause of [
      "`login-redirect` (`GET /auth/discord`), `login-callback` (`GET /auth/discord/callback`), `qa-login` (`POST /auth/qa/:identity`) in [`src/auth/routes.ts`](../src/auth/routes.ts)",
      "`alert-probe` in [`src/alert-probe.ts`](../src/alert-probe.ts)",
      "`logout` (`POST /logout`) in [`src/auth/routes.ts`](../src/auth/routes.ts)",
      "`event-write` on `POST /events`, `PATCH /events/:key` and `POST /events/:key/{publish,cancel,rsvp-pause,rsvp-reopen}` in [`src/events/routes-writes.ts`](../src/events/routes-writes.ts)",
    ]) {
      expect(throttlingDoc, `docs pin ${clause.slice(0, 48)}...`).toContain(clause);
    }
  });

  it("documents the MCP cap-before-throttle order in docs/body-limits.md", () => {
    expect(bodyLimitsDoc).toContain("POST /mcp");
    expect(bodyLimitsDoc).toContain("src/mcp/routes.ts");
    const mcp = stripComments(readFileSync(resolve(root, "src/mcp/routes.ts"), "utf8"));
    const capAt = mcp.indexOf('requestBodyLimit("mcp")');
    const admitAt = mcp.indexOf("admitted(c)");
    expect(capAt).toBeGreaterThanOrEqual(0);
    expect(admitAt).toBeGreaterThanOrEqual(0);
    expect(capAt).toBeLessThan(admitAt);
  });

  it("every src/ pointer in both docs resolves to an existing file", () => {
    for (const [name, doc] of [
      ["docs/throttling.md", throttlingDoc],
      ["docs/body-limits.md", bodyLimitsDoc],
    ] as const) {
      const pointers = new Set<string>();
      for (const match of doc.matchAll(/src\/[A-Za-z0-9._/-]+\.(?:tsx?|md)/g)) {
        pointers.add(match[0]);
      }
      expect(pointers.size, `${name} has src pointers`).toBeGreaterThan(0);
      for (const pointer of pointers) {
        expect(existsSync(resolve(root, pointer)), `${name} pointer ${pointer}`).toBe(true);
      }
    }
  });
});
