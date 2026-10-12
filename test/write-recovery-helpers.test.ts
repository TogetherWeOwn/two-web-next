import { type Context, Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import {
  consumeExpiredWrite,
  EXPIRED_WRITE_COOKIE,
  expiredWriteBanner,
  expiredWriteBounce,
  flashExpiredWrite,
  recoveryLanding,
  recoveryUrl,
} from "../src/write-recovery";

const SECRET = "local-fixture-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const env = { APP_URL, SESSION_SECRET: SECRET };

const signed = async (value: string) =>
  (await serializeSigned(EXPIRED_WRITE_COOKIE, value, SECRET, { path: "/", secure: true })).split(
    ";",
  )[0]!;
const cleared = (res: Response) =>
  res.headers
    .getSetCookie()
    .some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=") && /Max-Age=0/i.test(c));

describe("recoveryUrl", () => {
  it("preserves a safe destination with its query", () => {
    expect(recoveryUrl("/profile?edit=1")).toBe("/auth/recover?next=%2Fprofile%3Fedit%3D1");
    expect(recoveryUrl("/events")).toBe("/auth/recover?next=%2Fevents");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil",
    "javascript:alert(1)",
    "",
    " /profile",
  ])("refuses hostile or blank next %s to the profile fallback", (next) => {
    expect(recoveryUrl(next)).toBe("/auth/recover?next=%2Fprofile");
  });
});

describe("consumeExpiredWrite", () => {
  const app = new Hono();
  app.get("/consume", async (c) => c.json({ next: await consumeExpiredWrite(c) }));

  it("returns the pending destination and clears the cookie", async () => {
    const res = await app.request(
      "/consume",
      { headers: { cookie: await signed("pending|/profile?edit=1") } },
      env,
    );
    expect(await res.json()).toEqual({ next: "/profile?edit=1" });
    expect(cleared(res)).toBe(true);
  });

  it.each(["pending|https://evil.example/", "pending|//evil.example/", "pending|"])(
    "refuses hostile or empty pending value %s while still clearing it",
    async (value) => {
      const res = await app.request("/consume", { headers: { cookie: await signed(value) } }, env);
      expect(await res.json()).toEqual({ next: null });
      expect(cleared(res)).toBe(true);
    },
  );

  it.each(["restored|/profile", "pending", "restored"])(
    "ignores wrong-prefix or empty value %s",
    async (value) => {
      const res = await app.request("/consume", { headers: { cookie: await signed(value) } }, env);
      expect(await res.json()).toEqual({ next: null });
    },
  );

  it("ignores a forged unsigned cookie", async () => {
    const res = await app.request(
      "/consume",
      { headers: { cookie: EXPIRED_WRITE_COOKIE + "=forged" } },
      env,
    );
    expect(await res.json()).toEqual({ next: null });
  });

  it("returns null when no cookie is present", async () => {
    const res = await app.request("/consume", {}, env);
    expect(await res.json()).toEqual({ next: null });
  });
});

describe("flashExpiredWrite", () => {
  const app = new Hono();
  app.get("/flash", async (c) => {
    const next = c.req.query("next") ?? null;
    await flashExpiredWrite(c, next);
    return c.json({ flashed: next !== null });
  });
  const banner = new Hono();
  banner.use("*", expiredWriteBanner);
  banner.get(
    "/page",
    (c) =>
      new Response("<html><body><main>Document</main></body></html>", {
        headers: { "content-type": "text/html" },
      }),
  );

  it("sets nothing when there is no destination", async () => {
    const res = await app.request("/flash", {}, env);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("sets a restored notice that the banner renders exactly once", async () => {
    const res = await app.request("/flash?next=%2Fprofile%3Fedit%3D1", {}, env);
    const pair = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="))!
      .split(";")[0]!;
    const page = await banner.request("/page", { headers: { cookie: pair } }, env);
    expect(await page.text()).toContain('data-testid="auth-error"');
    expect(cleared(page)).toBe(true);
  });
});

describe("recoveryLanding", () => {
  const app = new Hono();
  app.get("/auth/recover", (c) => recoveryLanding(c));

  it("carries a safe destination into signed cookies and the login link", async () => {
    const res = await app.request("/auth/recover?next=%2Fprofile%3Fedit%3D1", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const html = await res.text();
    expect(html).toContain("Your earlier changes were not saved");
    expect(html).toContain('href="/auth/discord?next=%2Fprofile%3Fedit%3D1"');
    expect(html).not.toContain("Unsaved");
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith("__Host-two_login_intended="))).toBe(true);
    expect(set.some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="))).toBe(true);
  });

  it.each(["https://evil.example/", "//evil.example/", ""])(
    "falls back to /profile for hostile or blank next %s",
    async (next) => {
      const res = await app.request("/auth/recover?next=" + encodeURIComponent(next), {}, env);
      const html = await res.text();
      expect(html).toContain('href="/auth/discord?next=%2Fprofile"');
      expect(html).not.toContain("evil.example");
    },
  );
});

describe("expiredWriteBounce", () => {
  const bounce = (jsonOnly: boolean) => {
    const app = new Hono();
    const handler = (c: Context) => expiredWriteBounce(c, jsonOnly);
    app.post("/probe", handler);
    app.get("/probe", handler);
    app.post("/members/123", handler);
    app.post("/admin", handler);
    app.post("/admin/events", handler);
    app.post("/admin/events/abc/publish", handler);
    return app;
  };

  it("a JSON-only route keeps 401 with a recovery link and no redirect", async () => {
    const res = await bounce(true).request("/probe", { method: "POST" }, env);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      recovery: "/auth/recover?next=%2Fevents",
    });
  });

  it.each([
    ["accept", "application/json"],
    ["content-type", "application/json"],
  ])("a negotiated %s request keeps the JSON 401 shape", async (header, value) => {
    const res = await bounce(false).request(
      "/probe",
      { method: "POST", headers: { [header]: value } },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      recovery: "/auth/recover?next=%2Fevents",
    });
  });

  it("a native form POST redirects to recovery, never the write URL", async () => {
    const res = await bounce(false).request(
      "/probe",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fevents");
  });

  it("a same-origin referer becomes the recovery destination", async () => {
    const res = await bounce(false).request(
      "/probe",
      { method: "POST", headers: { referer: APP_URL + "/profile?edit=1" } },
      env,
    );
    expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fprofile%3Fedit%3D1");
  });

  it.each(["https://hostile.example/profile", APP_URL + "//evil.example/"])(
    "a hostile or unsafe referer %s falls back instead of being carried",
    async (referer) => {
      const res = await bounce(false).request(
        "/probe",
        { method: "POST", headers: { referer } },
        env,
      );
      expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fevents");
    },
  );

  it("member writes fall back to the profile, admin writes to their form page", async () => {
    const app = bounce(false);
    const hostile = { method: "POST", headers: { referer: "https://hostile.example/x" } } as const;
    expect((await app.request("/members/123", hostile, env)).headers.get("location")).toBe(
      "/auth/recover?next=%2Fprofile",
    );
    expect((await app.request("/admin/events", hostile, env)).headers.get("location")).toBe(
      "/auth/recover?next=%2Fadmin%2Fevents%2Fnew",
    );
    expect(
      (await app.request("/admin/events/abc/publish", hostile, env)).headers.get("location"),
    ).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
    expect((await app.request("/admin", hostile, env)).headers.get("location")).toBe(
      "/auth/recover?next=%2Fadmin",
    );
  });
});

describe("expiredWriteBanner", () => {
  const bannerApp = (body: string, status = 200, contentType = "text/html") => {
    const app = new Hono();
    app.use("*", expiredWriteBanner);
    app.get(
      "/page",
      (c) => new Response(body, { status, headers: { "content-type": contentType } }),
    );
    app.post(
      "/page",
      (c) => new Response(body, { status, headers: { "content-type": contentType } }),
    );
    app.get(
      "/auth/login",
      (c) => new Response(body, { status, headers: { "content-type": contentType } }),
    );
    return app;
  };
  const document = "<html><body><main>Document</main></body></html>";

  it("injects the one-shot banner on a full document and clears the notice", async () => {
    const res = await bannerApp(document).request(
      "/page",
      { headers: { cookie: await signed("restored|/profile?edit=1") } },
      env,
    );
    const html = await res.text();
    expect(html).toContain('data-testid="auth-error"');
    expect(html).toContain('href="/auth/recover?next=%2Fprofile%3Fedit%3D1"');
    expect(html).toContain("<main>");
    expect(cleared(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
  });

  it.each(["pending|/profile", "restored|https://evil.example/", EXPIRED_WRITE_COOKIE + "=forged"])(
    "shows no banner for non-restored or hostile value %s",
    async (cookieValue) => {
      const cookie =
        cookieValue === EXPIRED_WRITE_COOKIE + "=forged" ? cookieValue : await signed(cookieValue);
      const res = await bannerApp(document).request("/page", { headers: { cookie } }, env);
      expect(await res.text()).toBe(document);
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it("leaves the notice pending for POSTs, non-200s, non-HTML, auth pages and fragments", async () => {
    const cookie = await signed("restored|/profile");
    const cases: Array<[string, Response]> = [
      [
        "POST",
        await bannerApp(document).request("/page", { method: "POST", headers: { cookie } }, env),
      ],
      ["non-200", await bannerApp(document, 404).request("/page", { headers: { cookie } }, env)],
      [
        "non-HTML",
        await bannerApp('{"ok":true}', 200, "application/json").request(
          "/page",
          { headers: { cookie } },
          env,
        ),
      ],
      ["auth page", await bannerApp(document).request("/auth/login", { headers: { cookie } }, env)],
      [
        "fragment",
        await bannerApp("<main>Fragment only</main>").request(
          "/page",
          { headers: { cookie } },
          env,
        ),
      ],
    ];
    for (const [name, res] of cases) {
      expect(await res.text(), name).not.toContain("auth-error");
      expect(res.headers.getSetCookie(), name).toEqual([]);
    }
  });
});
