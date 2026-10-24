// Branded Kit 400/404/403/410/429/500/503 shells, negotiated helpers
// and the shared HTML outcome renderer. Hermetic: local fixtures only, no
// live services, no session/DB reads merely to offer recovery.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memberReadResponse } from "../src/member-reads";
import { dispatchHookRequest, resolveRouteOwner } from "../src/route-ownership";
import { trustHosts } from "../src/trust-hosts";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
};

const SECRETS = ["private fixture details", "123456789012345678", "198.51.100.42"];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("kit error fixtures must remain offline");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function assertNoLeak(body: string) {
  for (const secret of SECRETS) expect(body).not.toContain(secret);
}

describe("negotiated 403/410 helpers", () => {
  it("forbidden answers HTML to browsers with private no-store and Vary Accept", async () => {
    const { forbidden } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/forbidden", (c) => forbidden(c));
    const res = await f.request("/forbidden", {}, env);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("retry-after")).toBeNull();
    const html = await res.text();
    expect(html).toContain('class="recovery-code" aria-hidden="true">403</p>');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain("You do not have access");
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain("<script");
    assertNoLeak(html);
  });

  it("forbidden answers JSON when Accept prefers it, with quality/specificity/q=0 parity", async () => {
    const { forbidden } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/forbidden", (c) => forbidden(c));
    f.post("/events/:key/publish", (c) => forbidden(c));
    f.post("/api/thing", (c) => forbidden(c));
    const cases: Array<[string, RequestInit, boolean]> = [
      ["/forbidden", { headers: { accept: "application/json" } }, true],
      ["/forbidden", { headers: { accept: "APPLICATION/JSON" } }, true],
      ["/forbidden", { headers: { accept: "text/*, application/json" } }, true],
      ["/forbidden", {}, false],
      ["/forbidden", { headers: { accept: "*/*" } }, false],
      ["/forbidden", { headers: { accept: "application/json;q=0, text/html" } }, false],
      ["/events/abc/publish", { method: "POST", headers: { accept: "text/html" } }, true],
      ["/api/thing", { method: "POST", headers: { accept: "text/html" } }, true],
    ];
    for (const [path, init, isJson] of cases) {
      const res = await f.request(path, init, env);
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("vary")).toBe("Accept");
      if (isJson) {
        expect(await res.json()).toEqual({
          error: "forbidden",
          message: "You do not have access to this.",
        });
      } else {
        expect(await res.text()).toContain("You do not have access");
      }
    }
  });

  it("gone answers 410 HTML with private no-store, and JSON to JSON callers", async () => {
    const { gone } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/gone", (c) => gone(c));
    const htmlRes = await f.request("/gone", {}, env);
    expect(htmlRes.status).toBe(410);
    expect(htmlRes.headers.get("cache-control")).toBe("private, no-store");
    expect(htmlRes.headers.get("vary")).toBe("Accept");
    const html = await htmlRes.text();
    expect(html).toContain('class="recovery-code" aria-hidden="true">410</p>');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain("This page is gone");
    expect(html).toContain('href="/events"');
    expect(html).not.toContain("<script");
    assertNoLeak(html);

    const jsonRes = await f.request("/gone", { headers: { accept: "application/json" } }, env);
    expect(jsonRes.status).toBe(410);
    expect(await jsonRes.json()).toEqual({
      reason: "gone",
      message: "This page is gone.",
    });
  });

  it("feed paths keep a non-HTML contract instead of the branded shell", async () => {
    const { forbidden, gone } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.get("/events/:file{.+\\.ics}", (c) => forbidden(c));
    f.get("/retired.ics", (c) => gone(c));
    const denied = await f.request("/events/abc.ics", {}, env);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toMatch(/text\/plain/);
    const deniedBody = await denied.text();
    expect(deniedBody).toBe("Forbidden");
    expect(deniedBody).not.toContain("recovery-code");

    const retired = await f.request("/retired.ics", {}, env);
    expect(retired.status).toBe(410);
    expect(retired.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await retired.text()).not.toContain("recovery-code");
  });

  it("forbidden and gone release 403/410 inside the member-read boundary", async () => {
    const { forbidden, gone } = await import("../src/errors");
    const { memberReadBoundary } = await import("../src/member-reads");
    const sink = vi.fn(async () => true);
    const f = new Hono<{ Bindings: Env }>();
    f.use("*", (c, next) =>
      memberReadBoundary(
        c,
        { resource: "profile", action: "view", route: "test.kit-errors", viewer: null },
        sink,
        next,
      ),
    );
    f.get("/forbidden", (c) => forbidden(c));
    f.get("/gone", (c) => gone(c));
    f.get("/events/:file{.+\\.ics}", (c) => forbidden(c));
    f.get("/retired.ics", (c) => gone(c));

    const htmlForbidden = await f.request("/forbidden", {}, env);
    expect(htmlForbidden.status).toBe(403);
    expect(htmlForbidden.headers.get("content-type")).toMatch(/text\/html/);
    expect(htmlForbidden.headers.get("cache-control")).toBe("private, no-store");
    expect(htmlForbidden.headers.get("vary")).toContain("Accept");
    expect(await htmlForbidden.text()).toContain("You do not have access");

    const jsonForbidden = await f.request(
      "/forbidden",
      { headers: { accept: "application/json" } },
      env,
    );
    expect(jsonForbidden.status).toBe(403);
    expect(jsonForbidden.headers.get("content-type")).toMatch(/application\/json/);
    expect(jsonForbidden.headers.get("vary")).toContain("Accept");
    expect(await jsonForbidden.json()).toEqual({
      error: "forbidden",
      message: "You do not have access to this.",
    });

    const feedForbidden = await f.request("/events/abc.ics", {}, env);
    expect(feedForbidden.status).toBe(403);
    expect(feedForbidden.headers.get("content-type")).toMatch(/text\/plain/);
    expect(feedForbidden.headers.get("vary")).toContain("Accept");
    expect(await feedForbidden.text()).toBe("Forbidden");

    const htmlGone = await f.request("/gone", {}, env);
    expect(htmlGone.status).toBe(410);
    expect(htmlGone.headers.get("content-type")).toMatch(/text\/html/);
    expect(htmlGone.headers.get("cache-control")).toBe("private, no-store");
    expect(htmlGone.headers.get("vary")).toContain("Accept");
    expect(await htmlGone.text()).toContain("This page is gone");

    const jsonGone = await f.request("/gone", { headers: { accept: "application/json" } }, env);
    expect(jsonGone.status).toBe(410);
    expect(jsonGone.headers.get("content-type")).toMatch(/application\/json/);
    expect(jsonGone.headers.get("vary")).toContain("Accept");
    expect(await jsonGone.json()).toEqual({ reason: "gone", message: "This page is gone." });

    const feedGone = await f.request("/retired.ics", {}, env);
    expect(feedGone.status).toBe(410);
    expect(feedGone.headers.get("content-type")).toMatch(/text\/plain/);
    expect(feedGone.headers.get("vary")).toContain("Accept");
    expect(await feedGone.text()).toBe("Gone");

    // No member data was read, so recovery is offered with no audit row.
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("unknown and retired URLs stay 404", () => {
  it("unknown routes answer the branded 404 with noindex", async () => {
    const { notFoundHandler } = await import("../src/errors");
    const f = new Hono<{ Bindings: Env }>();
    f.notFound(notFoundHandler);
    f.get("/events/:file{.+\\.ics}", (c) => notFoundHandler(c));
    for (const path of ["/definitely-not-here", "/e/no-such", "/events/no-such.ics"]) {
      const res = await f.request(path, {}, env);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      const html = await res.text();
      expect(html).toContain("We cannot find that page");
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      assertNoLeak(html);
    }
  });

  it("retired /members stays a session-free 404, never a 410 or login bounce", async () => {
    const app = (await import("./app")).default;
    for (const path of ["/members", "/members/"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("We cannot find that page");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("Kit error surfaces", () => {
  it("missing /_app/* assets never gain the Kit marker", async () => {
    expect(resolveRouteOwner({ method: "GET", path: "/_app/immutable/chunks/abc.js" })).toBe(
      "hono",
    );
    const request = new Request(new URL("/_app/immutable/chunks/abc.js", env.APP_URL).href, {
      headers: { host: "next.example.test" },
    });
    const event = { request, url: new URL(request.url), route: { id: "/_app/immutable/x" } };
    const honoFetch = vi.fn(async () => new Response("hono-asset", { status: 404 }));
    const resolveFn = vi.fn(async () => new Response("must not resolve"));
    const res = await dispatchHookRequest(event, {
      appUrl: env.APP_URL,
      honoFetch,
      resolve: resolveFn,
    });
    expect(honoFetch).toHaveBeenCalledOnce();
    expect(resolveFn).not.toHaveBeenCalled();
    expect(res.headers.get("x-two-renderer")).toBeNull();
    expect(await res.text()).toBe("hono-asset");
  });

  it("a hostile Host is refused before Kit resolve with no host echo", async () => {
    const request = new Request(new URL("/events/past", env.APP_URL).href, {
      headers: { host: "evil.example" },
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const honoFetch = vi.fn(async () => new Response("hono"));
    const resolveFn = vi.fn(async () => new Response("must not resolve"));
    await dispatchHookRequest(event, {
      appUrl: env.APP_URL,
      manifest: [{ method: "GET", path: "/events/past", enabled: true, reads: "public" }],
      honoFetch,
      resolve: resolveFn,
    });
    expect(honoFetch).toHaveBeenCalledOnce();
    expect(resolveFn).not.toHaveBeenCalled();

    const f = new Hono<{ Bindings: Env }>();
    f.use("*", trustHosts());
    f.get("/events/past", (c) => c.text("ok"));
    const refused = await f.request("/events/past", { headers: { host: "evil.example" } }, env);
    expect(refused.status).toBe(404);
    expect(refused.headers.get("cache-control")).toBe("no-store, private");
    const body = await refused.text();
    expect(body).toContain("We cannot find that page");
    expect(body).not.toContain("evil.example");
  });

  it("a thrown Kit load inside the boundary becomes a sanitized 503 with no leak", async () => {
    const write = vi.fn(async () => true);
    const res = await memberReadResponse(
      { method: "GET", route: "test.thrown" },
      () => ({ viewer: null, resource: "profile", action: "view", route: "profile" }),
      write,
      async () => {
        throw new Error("private fixture details");
      },
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe("Member data is temporarily unavailable.");
    assertNoLeak(body);
  });

  it("an audit refusal never leaks subjects and writes no audit row", async () => {
    const { declareMemberResult, keyedMemberRead, memberQueryPermit } = await import(
      "../src/member-reads"
    );
    const write = vi.fn(async () => true);
    const res = await memberReadResponse(
      { method: "GET", route: "test.refused" },
      () => ({ viewer: null, resource: "profile", action: "view", route: "profile" }),
      write,
      async () => {
        const html = await keyedMemberRead(async () => {
          memberQueryPermit();
          declareMemberResult(["123456789012345678"]);
          return "<p>member</p>";
        });
        return new Response(html, { headers: { "content-type": "text/html" } });
      },
    );
    expect(res.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
    const body = await res.text();
    expect(body).toBe("Member data is temporarily unavailable.");
    expect(body).not.toContain("123456789012345678");
  });
});

describe("shared HTML outcome renderer", () => {
  it("one recovery adapter renders through the injected renderer exactly once", async () => {
    const { renderHtmlOutcome } = await import("../src/html-outcome");
    const { recoveryOutcome } = await import("../src/recovery-outcome");
    const { Hono } = await import("hono");
    const calls: unknown[] = [];
    const outcome = recoveryOutcome(
      {
        title: "Your session expired",
        message: "Sign in again, then review and submit them when you are ready.",
        retryUrl: "/auth/discord?next=%2Fprofile",
        retryLabel: "Log in with Discord",
        inviteUrl: "/discord",
      },
      async (model) => {
        calls.push(model);
        return `<main><h1 id="recovery-heading">${model.title}</h1><a href="${model.retryUrl}" data-testid="recovery-retry">${model.retryLabel}</a><a href="${model.inviteUrl}" data-testid="recovery-invite">invite</a></main>`;
      },
    );
    const f = new Hono<{ Bindings: Env }>();
    f.get("/recover", (c) => renderHtmlOutcome(c, outcome));
    const res = await f.request("/recover", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain('id="recovery-heading"');
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain('data-testid="recovery-invite"');
    // Buffered and executed once: a second render reuses the same bytes.
    const second = new Hono<{ Bindings: Env }>();
    second.get("/recover", (c) => renderHtmlOutcome(c, outcome));
    expect(await (await second.request("/recover", {}, env)).text()).toBe(html);
    expect(calls).toHaveLength(1);
  });

  it("Hono-to-outcome identity: same model, status and headers as the direct render", async () => {
    const { renderHtmlOutcome } = await import("../src/html-outcome");
    const { recoveryOutcome } = await import("../src/recovery-outcome");
    const { Hono } = await import("hono");
    const model = {
      title: "Your session expired",
      message: "idem",
      retryUrl: "/auth/discord?next=%2Fprofile",
      retryLabel: "Log in with Discord",
      inviteUrl: "/discord",
    };
    const direct = new Hono<{ Bindings: Env }>();
    direct.get("/direct", (c) => {
      c.header("cache-control", "no-store, private");
      return c.html(`<main><h1>${model.title}</h1><p>${model.message}</p></main>`, 200);
    });
    const via = new Hono<{ Bindings: Env }>();
    via.get("/direct", (c) =>
      renderHtmlOutcome(
        c,
        recoveryOutcome(model, async (m) => `<main><h1>${m.title}</h1><p>${m.message}</p></main>`, {
          status: 200,
          headers: { "cache-control": "no-store, private" },
        }),
      ),
    );
    const a = await direct.request("/direct", {}, env);
    const b = await via.request("/direct", {}, env);
    expect(b.status).toBe(a.status);
    expect(b.headers.get("cache-control")).toBe(a.headers.get("cache-control"));
    expect(await b.text()).toBe(await a.text());
  });
});

describe("Kit Svelte error shells (text pins; the root suite cannot transform Svelte)", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  it("ErrorShell renders every Kit status with shared chrome and no session/DB reads", () => {
    const shell = read("web/src/lib/ErrorShell.svelte");
    // Single source of truth: copy lives in src/kit-errors.ts, the shell
    // imports it and branches per status — never duplicates the strings.
    expect(shell).toContain("kitErrorCopy");
    expect(shell).toContain("../../../src/kit-errors");
    for (const code of ["400", "404", "403", "410", "429", "500", "503"]) {
      expect(shell).toContain(code);
    }
    expect(shell).toContain("noindex, nofollow");
    expect(shell).toContain('data-testid="error-home"');
    expect(shell).toContain('data-testid="error-invite"');
    expect(shell).toContain('data-testid="error-join"');
    expect(shell).not.toMatch(/dbFor|getSignedCookie|readSession|fetch\(/);
    expect(shell).not.toContain("<script src");
    expect(shell).not.toContain("{@html");
    expect(shell).toContain("Shell");
  });

  it("+error.svelte maps every status without echoing the failure", () => {
    const page = read("web/src/routes/+error.svelte");
    expect(page).toContain("ErrorShell");
    expect(page).toContain("isKitErrorStatus");
    expect(page).toContain("FALLBACK_INVITE");
    expect(page).not.toMatch(/page\.error/);
    expect(page).not.toMatch(/dbFor|getSignedCookie|readSession|fetch\(/);
    expect(page).toContain("noindex");
  });

  it("+error.svelte falls unknown statuses back to the 500 shell, no echo, noindex intact", async () => {
    const { isKitErrorStatus, kitErrorCopy } = await import("../src/kit-errors");
    const page = read("web/src/routes/+error.svelte");
    // Svelte cannot be transformed here, so pin the exact fallback expression
    // and evaluate its semantics: a pass-through (`: page.status`), a wider
    // status set, a dropped shell, an echoed failure or a dropped noindex
    // each fail below instead of silently rendering nothing or leaking.
    expect(page).toContain(
      "const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);",
    );
    expect(page).toContain(
      "<ErrorShell code={status} inviteUrl={FALLBACK_INVITE} adminBack={adminBack} />",
    );
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page).not.toMatch(/page\.error/);
    for (const unknown of [401, 418, 502, 999]) {
      const status = isKitErrorStatus(unknown) ? unknown : 500;
      expect(status).toBe(500);
      expect(kitErrorCopy(status)).toEqual({
        code: "500",
        title: "Something broke on our side",
        lead: "It is not you. We have logged the failure and the team will take a look.",
      });
    }
    for (const known of [400, 404, 403, 410, 429, 500, 503] as const) {
      expect(isKitErrorStatus(known) ? known : 500).toBe(known);
    }
  });

  it("kit-errors copy matches the Hono shells and negotiates without swallowing machine contracts", async () => {
    const { kitErrorCopy, negotiateKitError } = await import("../src/kit-errors");
    expect(kitErrorCopy(404).title).toBe("We cannot find that page");
    expect(kitErrorCopy(403).title).toContain("do not have access");
    expect(kitErrorCopy(410).title).toBe("This page is gone");
    expect(kitErrorCopy(429).title).toBe("Slow down a little");
    expect(kitErrorCopy(500).title).toBe("Something broke on our side");
    expect(kitErrorCopy(503).title).toBe("We will be right back");
    const json = new Request("https://next.example.test/gone", {
      headers: { accept: "application/json" },
    });
    expect(negotiateKitError(json)).toBe("json");
    const machine = new Request("https://next.example.test/api/thing", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    expect(negotiateKitError(machine)).toBe("json");
    const browser = new Request("https://next.example.test/gone");
    expect(negotiateKitError(browser)).toBe("html");
    const excluded = new Request("https://next.example.test/gone", {
      headers: { accept: "application/json;q=0, text/html" },
    });
    expect(negotiateKitError(excluded)).toBe("html");
  });

  it("negotiateKitError keeps browser event GETs as HTML, feeds as text, writes as JSON", async () => {
    const { negotiateKitError } = await import("../src/kit-errors");
    const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    for (const path of ["/events/past", "/events", "/events/01HXYZ"]) {
      expect(
        negotiateKitError(
          new Request(`https://next.example.test${path}`, {
            headers: { accept: browserAccept },
          }),
        ),
      ).toBe("html");
    }
    expect(
      negotiateKitError(
        new Request("https://next.example.test/events/abc.ics", {
          headers: { accept: browserAccept },
        }),
      ),
    ).toBe("text");
    expect(negotiateKitError(new Request("https://next.example.test/events/abc.ics"))).toBe("text");
    expect(
      negotiateKitError(
        new Request("https://next.example.test/events", {
          method: "POST",
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe("json");
  });
});
