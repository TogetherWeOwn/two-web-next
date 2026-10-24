// Inline-style route sweep + leaf-bundle hash lifecycle (threat-model gaps
// row: a page outside the five inline-critical paths emits an inline <style>
// block, or the leaf bundle is regenerated without updating its recorded
// hash). The sweep walks the live Hono route registry, so a new route is
// swept automatically; the canary fixtures below prove the assertion is not
// vacuous. The lifecycle check fails when bundle bytes change without the
// recorded hash, on mutate-copy fixtures only — never the real bundle.
//
// Stable check IDs: style-route-sweep, leaf-hash-lifecycle (see
// ci/check-security-pins.mjs and docs/security-pin-contracts.md). The
// threat-model rows stay the single source of truth; this file only pins the
// executable behavior. Kit-rendered responses mirror the same bytes and hash
// under the kit-parity gates and are outside this Hono sweep.

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import rawApp from "../src/index";
import type { Env } from "../src/env";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const TRUSTED = "next.example.test";
// The only Hono responses allowed to carry an inlined block (src/headers.ts
// INLINE_CRITICAL_CSS_PATHS). The static gate pins this set byte-for-byte;
// the sweep pins what each path actually emits.
const INLINE_CRITICAL_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
]);
const EXPECTED_BLOCK = `<style>${LEAF_CRITICAL_CSS}</style>`;
const INLINE_STYLE_OPEN = /<style[\s>]/i;

type SweepOutcome =
  | { kind: "allowlisted"; path: string }
  | { kind: "clean"; path: string }
  | { kind: "skipped"; path: string; reason: string }
  | { kind: "violation"; path: string; detail: string };

function cspDirective(csp: string, name: string): string | null {
  for (const part of csp.split(";")) {
    const [directive, ...sources] = part.trim().split(/\s+/);
    if (directive === name) return sources.join(" ");
  }
  return null;
}

async function classifyResponse(
  path: string,
  res: Response,
  ctx: { allowlist: ReadonlySet<string>; expectedBlock: string; leafHash: string },
): Promise<SweepOutcome> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return { kind: "skipped", path, reason: `${res.status} ${contentType || "no content-type"}` };
  }
  const body = await res.text();
  const csp = res.headers.get("content-security-policy") ?? "";
  if (csp.includes("unsafe-inline")) {
    return { kind: "violation", path, detail: "CSP contains unsafe-inline" };
  }
  if (ctx.allowlist.has(path)) {
    if (!body.includes(ctx.expectedBlock)) {
      return {
        kind: "violation",
        path,
        detail: "allowlisted path is missing the exact inlined block",
      };
    }
    const styleSrc = cspDirective(csp, "style-src");
    if (styleSrc !== `'self' 'sha256-${ctx.leafHash}'`) {
      return {
        kind: "violation",
        path,
        detail: `allowlisted style-src is ${styleSrc ?? "missing"}`,
      };
    }
    // Presence is not exactness: an extra block beside the expected one is
    // not covered by the recorded hash, so strip the expected block and fail
    // if any further inline <style> emission remains.
    if (INLINE_STYLE_OPEN.test(body.replace(ctx.expectedBlock, ""))) {
      return {
        kind: "violation",
        path,
        detail: "allowlisted path emits an inline <style> block beyond the exact block",
      };
    }
    return { kind: "allowlisted", path };
  }
  if (INLINE_STYLE_OPEN.test(body)) {
    return {
      kind: "violation",
      path,
      detail: "non-allowlisted HTML emits an inline <style> block",
    };
  }
  const styleSrc = cspDirective(csp, "style-src");
  if (styleSrc !== "'self'") {
    return {
      kind: "violation",
      path,
      detail: `non-allowlisted style-src is ${styleSrc ?? "missing"}, expected exactly 'self'`,
    };
  }
  return { kind: "clean", path };
}

// Every GET-serving registration becomes one concrete request: :params become
// fixture segments (regex params keep a matching suffix), wildcards become a
// fixture segment. Error, redirect and auth-wall responses are asserted too:
// whatever a route renders under fixtures must comply.
const PARAM_RE = /:([a-zA-Z0-9_]+)(\{[^}]*\})?/g;
function concretePaths(): string[] {
  const paths = rawApp.routes
    .filter((r) => r.method === "GET" || r.method === "ALL")
    .map((r) =>
      r.path
        .replace(PARAM_RE, (_match, _name: string, brace: string | undefined) => {
          if (brace?.includes("\\.md")) return "fixture.md";
          if (brace?.includes("\\.ics")) return "fixture.ics";
          return "fixture";
        })
        .replaceAll("*", "fixture"),
    );
  return [...new Set(paths)];
}

const SWEEP_CTX = {
  allowlist: INLINE_CRITICAL_PATHS,
  expectedBlock: EXPECTED_BLOCK,
  leafHash: LEAF_CRITICAL_CSS_SHA256,
};

async function sweepAll(): Promise<SweepOutcome[]> {
  const outcomes: SweepOutcome[] = [];
  for (const path of concretePaths()) {
    const res = await rawApp.request(`${env.APP_URL}${path}`, { headers: { host: TRUSTED } }, env);
    outcomes.push(await classifyResponse(path, res, SWEEP_CTX));
  }
  return outcomes;
}

// Fixture-only Hono app: the canary route emits an inline block the sweep
// must flag, and the wrong-block route carries different bytes under the
// real hash. Neither route exists in src/; they prove the sweep detects.
function canaryFixture() {
  const fixture = new Hono();
  fixture.get("/clean", (c) => {
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self'");
    return c.html(
      '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body>clean</body></html>',
    );
  });
  fixture.get("/canary", (c) => {
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self'");
    return c.html(
      "<!doctype html><html><head><style>p{color:red}</style></head><body>canary</body></html>",
    );
  });
  fixture.get("/wrong-block", (c) => {
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`,
    );
    return c.html(
      "<!doctype html><html><head><style>p{color:blue}</style></head><body>wrong bytes</body></html>",
    );
  });
  fixture.get("/extra-block", (c) => {
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`,
    );
    return c.html(
      `<!doctype html><html><head>${EXPECTED_BLOCK}<style>p{color:red}</style></head><body>extra block</body></html>`,
    );
  });
  return fixture;
}

describe("inline-style route sweep", () => {
  it("canary: an off-allowlist emission is flagged, a clean page passes", async () => {
    const fixture = canaryFixture();
    const ctx = { ...SWEEP_CTX, allowlist: new Set<string>([]) };
    expect(await classifyResponse("/clean", await fixture.request("/clean"), ctx)).toMatchObject({
      kind: "clean",
    });
    expect(await classifyResponse("/canary", await fixture.request("/canary"), ctx)).toMatchObject({
      kind: "violation",
      detail: "non-allowlisted HTML emits an inline <style> block",
    });
  });

  it("canary: an allowlisted path with different bytes is flagged, not merely present", async () => {
    const fixture = canaryFixture();
    const ctx = { ...SWEEP_CTX, allowlist: new Set(["/wrong-block"]) };
    expect(
      await classifyResponse("/wrong-block", await fixture.request("/wrong-block"), ctx),
    ).toMatchObject({
      kind: "violation",
      detail: "allowlisted path is missing the exact inlined block",
    });
  });

  it("canary: an allowlisted path with an extra block beyond the exact block is flagged", async () => {
    const fixture = canaryFixture();
    const ctx = { ...SWEEP_CTX, allowlist: new Set(["/extra-block"]) };
    expect(
      await classifyResponse("/extra-block", await fixture.request("/extra-block"), ctx),
    ).toMatchObject({
      kind: "violation",
      detail: "allowlisted path emits an inline <style> block beyond the exact block",
    });
  });

  it.each(concretePaths())("route %s carries no unallowlisted inline style", async (path) => {
    const res = await rawApp.request(`${env.APP_URL}${path}`, { headers: { host: TRUSTED } }, env);
    const outcome = await classifyResponse(path, res, SWEEP_CTX);
    expect(
      outcome.kind !== "violation",
      outcome.kind === "violation" ? `${path}: ${outcome.detail}` : path,
    ).toBe(true);
  });

  it("observes every allowlisted path with the exact block under a hash-allowlisted CSP", async () => {
    for (const path of INLINE_CRITICAL_PATHS) {
      const res = await rawApp.request(
        `${env.APP_URL}${path}`,
        { headers: { host: TRUSTED } },
        env,
      );
      expect(res.status).toBe(200);
      const outcome = await classifyResponse(path, res, SWEEP_CTX);
      expect(outcome, `${path} must sweep as allowlisted`).toMatchObject({ kind: "allowlisted" });
    }
  });

  it("sweep completeness: every registration gets one outcome, floors hold", async () => {
    const outcomes = await sweepAll();
    expect(outcomes).toHaveLength(concretePaths().length);
    const kinds = outcomes.map((o) => o.kind);
    expect(outcomes.filter((o) => o.kind === "allowlisted")).toHaveLength(
      INLINE_CRITICAL_PATHS.size,
    );
    // Floors, not exact counts: new routes change the totals. The sweep must
    // still observe non-allowlisted HTML shells and skip non-HTML bodies, or
    // a fixture collapse (every route redirecting, every body empty) would
    // pass silently.
    expect(kinds.filter((k) => k === "clean").length).toBeGreaterThanOrEqual(5);
    expect(kinds.filter((k) => k === "skipped").length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === "violation")).toEqual([]);
  });
});

export type LeafVerification =
  | { ok: true }
  | { ok: false; code: "leaf_hash_mismatch"; next_action: string };

// The regeneration check: recompute the bundle hash and compare it to the
// recorded constant. Bytes that changed without the recorded hash fail;
// bytes with their matching hash pass. Pure and read-only.
export function verifyLeafBundle(bytes: string, recordedHash: string): LeafVerification {
  const actual = createHash("sha256").update(bytes, "utf8").digest("base64");
  if (actual !== recordedHash) {
    return {
      ok: false,
      code: "leaf_hash_mismatch",
      next_action:
        "Run node ci/build-leaf-css.mjs to regenerate src/leaf-critical-css.ts, then re-run this suite.",
    };
  }
  return { ok: true };
}

describe("leaf-bundle hash lifecycle", () => {
  it("accepts the recorded bytes under the recorded hash", () => {
    expect(verifyLeafBundle(LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256)).toEqual({ ok: true });
  });

  it("rejects a mutate-copy whose bytes changed without the recorded hash", () => {
    const mutated = `${LEAF_CRITICAL_CSS}\n/* regenerated without updating the hash */\n`;
    expect(verifyLeafBundle(mutated, LEAF_CRITICAL_CSS_SHA256)).toEqual({
      ok: false,
      code: "leaf_hash_mismatch",
      next_action:
        "Run node ci/build-leaf-css.mjs to regenerate src/leaf-critical-css.ts, then re-run this suite.",
    });
  });

  it("rejects the recorded bytes under a wrong hash", () => {
    const wrong = `X${LEAF_CRITICAL_CSS_SHA256.slice(1)}`;
    expect(verifyLeafBundle(LEAF_CRITICAL_CSS, wrong).ok).toBe(false);
  });

  it("accepts changed bytes once their hash is recorded (compare, not just reject)", () => {
    const mutated = `${LEAF_CRITICAL_CSS}\n/* regenerated with its hash */\n`;
    const recomputed = createHash("sha256").update(mutated, "utf8").digest("base64");
    expect(verifyLeafBundle(mutated, recomputed)).toEqual({ ok: true });
  });
});
