// Acceptance: the 403 names the join-to-unlock path instead of advising
// re-sign-in. A signed-in viewer who lacks membership cannot fix a refusal by
// signing in again — the member bit comes from the join flow — and the same
// wrong advice hits members on moderator-only links. Both twins must tell the
// truth for both cases with a working recovery link.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Hono 403 lead: no "sign in again"; names join-to-unlock (join + unlock)
//   and keeps the moderator scoping (no false promise for moderator-only
//   pages). Title byte-identical: "You do not have access to this".
// - Hono 403 recovery: a working link to the unlock path with pinned testid
//   error-join-unlock and href exactly "/join"; existing error-invite and
//   error-home CTAs kept; no OAuth start (/auth/discord) on 403.
// - Kit 403: byte-identical title/copy via kit-errors data with the same
//   recovery in the Svelte shell; the 403 branch splits off from the shared
//   429/500 invite branch; error-join-unlock appears exactly once (403 only).
// - JSON 403 envelope byte-stable; 404/410/429 shells untouched per twin.
// - Sessionless contract kept: no session, cookie or DB reads in any error
//   shell; 403 renders offline with no set-cookie.
//
// Hermetic: local renders only, no DB, no live services. The Svelte shell is
// pinned via source text (the root suite cannot transform Svelte); the
// browser suite pins rendered links separately and the builder updates its
// 403 link set there.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { kitErrorCopy } from "../src/kit-errors";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
};

const BROWSER = "text/html,application/xhtml+xml";
const TITLE_403 = "You do not have access to this";
const UNLOCK_TESTID = "error-join-unlock";
const UNLOCK_HREF = "/join";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("403 acceptance fixtures must remain offline");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function innerText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function leadText(html: string): string {
  const match = /<p class="lead">([\s\S]*?)<\/p>/.exec(html);
  expect(match, "403 carries exactly one lead paragraph").not.toBeNull();
  return innerText(match![1]!);
}

function headingText(html: string): string {
  const match = /<h1 id="error-heading">([\s\S]*?)<\/h1>/.exec(html);
  expect(match, "403 carries the branded heading").not.toBeNull();
  return innerText(match![1]!);
}

async function hono403Html(): Promise<{ status: number; html: string; res: Response }> {
  const { forbidden } = await import("../src/errors");
  const f = new Hono<{ Bindings: Env }>();
  f.get("/forbidden", (c) => forbidden(c));
  const res = await f.request("/forbidden", { headers: { accept: BROWSER } }, env);
  const html = await res.text();
  return { status: res.status, html, res };
}

describe("403 join-to-unlock acceptance: Hono twin", () => {
  it("lead no longer advises re-sign-in; names join-to-unlock and keeps moderator scoping", async () => {
    const { status, html } = await hono403Html();
    expect(status).toBe(403);
    const lead = leadText(html);
    expect(lead.toLowerCase()).not.toContain("sign in again");
    expect(html.toLowerCase()).not.toContain("sign in again");
    expect(lead.toLowerCase()).toContain("join");
    expect(lead.toLowerCase()).toContain("unlock");
    expect(lead.toLowerCase()).toContain("moderator");
  });

  it("recovery names + links the unlock path with the pinned testid; invite/home kept", async () => {
    const { html } = await hono403Html();
    expect(html).toContain(TITLE_403);
    expect(headingText(html)).toBe(TITLE_403);
    const link = new RegExp(`<a\\b[^>]*data-testid="${UNLOCK_TESTID}"[^>]*>([\\s\\S]*?)</a>`).exec(
      html,
    );
    expect(link, `403 carries a recovery link with data-testid="${UNLOCK_TESTID}"`).not.toBeNull();
    expect(link![0]).toContain(`href="${UNLOCK_HREF}"`);
    expect(innerText(link![1]!).toLowerCase()).toContain("join");
    expect(html).toContain('data-testid="error-invite"');
    expect(html).toContain('data-testid="error-home"');
  });

  it("control: no login loop or OAuth start on 403", async () => {
    const { html } = await hono403Html();
    expect(html).not.toContain('href="/auth/discord"');
    expect(html).not.toContain('data-testid="error-join"');
  });
});

describe("403 join-to-unlock acceptance: Kit twin", () => {
  it("kit-errors 403 lead honest; title byte-identical to the Hono twin", async () => {
    const copy = kitErrorCopy(403);
    expect(copy.code).toBe("403");
    expect(copy.title).toBe(TITLE_403);
    const { html } = await hono403Html();
    expect(headingText(html)).toBe(copy.title);
    expect(copy.lead.toLowerCase()).not.toContain("sign in again");
    expect(copy.lead.toLowerCase()).toContain("join");
    expect(copy.lead.toLowerCase()).toContain("unlock");
    expect(copy.lead.toLowerCase()).toContain("moderator");
  });

  it("Svelte shell offers the same unlock recovery for 403 only", () => {
    const shell = read("web/src/lib/ErrorShell.svelte");
    expect(shell).toContain("kitErrorCopy");
    expect(shell).toContain(`data-testid="${UNLOCK_TESTID}"`);
    expect(shell).toContain(`href="${UNLOCK_HREF}"`);
    // The 403 branch splits off the shared invite branch: one unlock link,
    // rendered only for 403 — never for 429/500/others.
    expect(shell).not.toContain("code === 403 || code === 429 || code === 500");
    expect(shell.split(`data-testid="${UNLOCK_TESTID}"`)).toHaveLength(2);
    expect(shell).toContain('data-testid="error-invite"');
    expect(shell).toContain('data-testid="error-home"');
  });
});

describe("403 join-to-unlock acceptance: JSON envelope byte-stable", () => {
  it("JSON 403 keeps its exact bytes, keys and message", async () => {
    const { forbidden } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/forbidden", (c) => forbidden(c));
    const res = await f.request("/forbidden", { headers: { accept: "application/json" } }, env);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const text = await res.text();
    expect(text).toBe('{"error":"forbidden","message":"You do not have access to this."}');
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(["error", "message"]);
  });
});

describe("403 join-to-unlock acceptance: sibling shells untouched", () => {
  it("Hono 404 keeps its copy and join-via-OAuth recovery; no unlock link", async () => {
    const { notFoundHandler } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.notFound(notFoundHandler);
    const res = await f.request("/definitely-not-here", { headers: { accept: BROWSER } }, env);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("We cannot find that page");
    expect(leadText(html).toLowerCase()).toContain("link may be old");
    expect(html).toContain('data-testid="error-join"');
    expect(html).toContain('href="/auth/discord"');
    expect(html).toContain('data-testid="error-home"');
    expect(html).toContain('data-testid="error-all-events"');
    expect(html).not.toContain(`data-testid="${UNLOCK_TESTID}"`);
    expect(html).not.toContain(`href="${UNLOCK_HREF}"`);
  });

  it("Hono 410 keeps its copy and events recovery; no unlock link", async () => {
    const { gone } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/gone", (c) => gone(c));
    const res = await f.request("/gone", { headers: { accept: BROWSER } }, env);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain("This page is gone");
    expect(leadText(html)).toContain("The page was removed.");
    expect(html).toContain('data-testid="error-events"');
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain(`data-testid="${UNLOCK_TESTID}"`);
    expect(html).not.toContain(`href="${UNLOCK_HREF}"`);
  });

  it("Hono 429 keeps its invite recovery; no unlock link, no OAuth start", async () => {
    const { rateLimitExceeded } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/throttled", (c) => rateLimitExceeded(c));
    const res = await f.request("/throttled", { headers: { accept: BROWSER } }, env);
    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).toContain("Slow down a little");
    expect(leadText(html).toLowerCase()).toContain("lot of requests");
    expect(html).toContain('data-testid="error-invite"');
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain(`data-testid="${UNLOCK_TESTID}"`);
    expect(html).not.toContain(`href="${UNLOCK_HREF}"`);
    expect(html).not.toContain('href="/auth/discord"');
  });

  it("Kit 404/410/429 copy byte-stable", () => {
    expect(kitErrorCopy(404)).toEqual({
      code: "404",
      title: "We cannot find that page",
      lead: "The link may be old or mistyped, or the page may have moved.",
    });
    expect(kitErrorCopy(410)).toEqual({
      code: "410",
      title: "This page is gone",
      lead: "The page was removed. The lobby is still open — come in and say hello.",
    });
    expect(kitErrorCopy(429)).toEqual({
      code: "429",
      title: "Slow down a little",
      lead: "You have made a lot of requests in a short time. Wait a moment and try again.",
    });
  });
});

describe("403 join-to-unlock acceptance: sessionless error shells", () => {
  it("Hono 403 renders offline with no cookie and no session/cookie/DB reads", async () => {
    const { status, html, res } = await hono403Html();
    expect(status).toBe(403);
    expect(html).toContain(TITLE_403);
    expect(res.headers.get("set-cookie")).toBeNull();
    const tokens = (res.headers.get("cache-control") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .sort();
    expect(tokens).toEqual(["no-store", "private"]);
    const pages = read("src/error-pages.tsx");
    expect(pages).toContain("No session or cookie reads");
    expect(pages).not.toMatch(/getSignedCookie|readSession|sessionStoreFor|dbFor|fetch\(/);
  });

  it("Kit 403 copy and shells perform no session, cookie or DB reads", () => {
    expect(kitErrorCopy(403).title).toBe(TITLE_403);
    const data = read("src/kit-errors.ts");
    expect(data).toContain("No session, cookie or DB");
    expect(data).not.toMatch(/getSignedCookie|readSession|sessionStoreFor|dbFor|fetch\(/);
    for (const path of ["web/src/lib/ErrorShell.svelte", "web/src/routes/+error.svelte"]) {
      const shell = read(path);
      expect(shell).not.toMatch(/dbFor|getSignedCookie|readSession|fetch\(/);
    }
  });
});
