// Restored-write notice: verified display bit (readKitRestoredWrite), request
// metadata gate (isKitNoticeDocument), the dispatch that feeds locals and
// consumes the cookie, and the real root +layout.server.ts load in between.
// Hermetic: local fixtures only. The release-boundary cases use a plain marker
// response; the composition cases use the real root load and a renderer that
// only echoes the root prop, never an inline auth banner.
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { fileURLToPath, URL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isKitNoticeDocument, readKitRestoredWrite } from "../src/kit-restored-write";
import {
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";

const APP_URL = "https://next.example.test";
const SECRET = "restored-write-test-secret";
const RAY = "0123456789abcdef-LHR";
const MARKER =
  '<main><div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div></main>';
const FULL_HTML = `<!doctype html><html><body>${MARKER}</body></html>`;
const NAV = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

let rootLoad: (input: { locals: Record<string, unknown> }) => Record<string, unknown>;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../web/src/routes/+layout.server.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
  });
  const source = Buffer.from(outputFiles[0]!.text).toString("base64");
  ({ load: rootLoad } = await import(`data:text/javascript;base64,${source}`));
});

async function signed(value: string, secret = SECRET): Promise<string> {
  return (
    await serializeSigned(EXPIRED_WRITE_COOKIE, value, secret, { path: "/", secure: true })
  ).split(";")[0]!;
}

function req(headers: Record<string, string> = {}, path = "/about", method = "GET"): Request {
  return new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: "next.example.test", ...headers },
  });
}

async function dispatch(
  request: Request,
  resolve: (event: HookEventLike) => Response | Promise<Response>,
  extra: Partial<HookDispatchDeps> = {},
  isDataRequest = false,
) {
  const event: HookEventLike = {
    request,
    url: new URL(request.url),
    route: { id: new URL(request.url).pathname },
    isDataRequest,
  };
  const res = await dispatchHookRequest(event, {
    appUrl: APP_URL,
    sessionSecret: SECRET,
    manifest: [
      { method: "GET", path: "/about", enabled: true, reads: "public" },
      { method: "GET", path: "/events/past", enabled: true, reads: "public" },
      { method: "GET", path: "/auth/error", enabled: true, reads: "public" },
    ],
    honoFetch: async () => new Response("must not hono", { status: 500 }),
    resolve: async (e) => resolve(e as HookEventLike),
    ...extra,
  });
  return res;
}

const html = (body = FULL_HTML, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });

describe("isKitNoticeDocument", () => {
  it("accepts navigations and metadata-less GETs", () => {
    expect(isKitNoticeDocument(req(NAV))).toBe(true);
    expect(isKitNoticeDocument(req())).toBe(true);
  });

  it("rejects non-GET, data, island, fetch, prefetch and auth paths", () => {
    expect(isKitNoticeDocument(req(NAV, "/about", "POST"))).toBe(false);
    expect(isKitNoticeDocument(req(NAV), true)).toBe(false);
    expect(isKitNoticeDocument(req({ ...NAV, "x-two-island": "1" }))).toBe(false);
    expect(isKitNoticeDocument(req({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }))).toBe(
      false,
    );
    expect(isKitNoticeDocument(req({ "sec-fetch-dest": "empty" }))).toBe(false);
    expect(isKitNoticeDocument(req({ ...NAV, purpose: "prefetch" }))).toBe(false);
    expect(isKitNoticeDocument(req({ ...NAV, "sec-purpose": "prefetch" }))).toBe(false);
    expect(isKitNoticeDocument(req(NAV, "/auth/error"))).toBe(false);
    expect(isKitNoticeDocument(req(NAV, "/auth"))).toBe(false);
    expect(isKitNoticeDocument(req(NAV, "/%61uth/error"))).toBe(false);
    expect(isKitNoticeDocument(req(NAV, "/about/__data.json"))).toBe(false);
  });
});

describe("readKitRestoredWrite", () => {
  const withCookie = async (value: string, headers: Record<string, string> = NAV) =>
    req({ ...headers, cookie: await signed(value) });

  it("is true only for a validly signed restored|safe value", async () => {
    expect(await readKitRestoredWrite(await withCookie("restored|/events/42"), SECRET)).toBe(true);
  });

  it("stays false for pending, unsafe, tampered, wrong-secret, unsigned and missing values", async () => {
    expect(await readKitRestoredWrite(await withCookie("pending|/events/42"), SECRET)).toBe(false);
    expect(await readKitRestoredWrite(await withCookie("restored|//evil.test"), SECRET)).toBe(
      false,
    );
    expect(
      await readKitRestoredWrite(await withCookie("restored|https://evil.test/"), SECRET),
    ).toBe(false);
    expect(await readKitRestoredWrite(await withCookie("restored|"), SECRET)).toBe(false);
    const good = await signed("restored|/events/42");
    expect(good).toContain("%2F42");
    expect(
      await readKitRestoredWrite(req({ ...NAV, cookie: good.replace("%2F42", "%2F43") }), SECRET),
    ).toBe(false);
    expect(
      await readKitRestoredWrite(
        req({ ...NAV, cookie: await signed("restored|/events/42", "other-secret") }),
        SECRET,
      ),
    ).toBe(false);
    expect(
      await readKitRestoredWrite(
        req({ ...NAV, cookie: `${EXPIRED_WRITE_COOKIE}=restored|/events/42` }),
        SECRET,
      ),
    ).toBe(false);
    expect(await readKitRestoredWrite(req(NAV), SECRET)).toBe(false);
  });

  it("stays false without a secret or for non-document requests", async () => {
    const ok = await withCookie("restored|/events/42");
    expect(await readKitRestoredWrite(ok, undefined)).toBe(false);
    expect(await readKitRestoredWrite(ok, "")).toBe(false);
    expect(await readKitRestoredWrite(ok, SECRET, true)).toBe(false);
    expect(
      await readKitRestoredWrite(
        await withCookie("restored|/events/42", { "sec-fetch-dest": "empty" }),
        SECRET,
      ),
    ).toBe(false);
  });
});

describe("dispatch: locals and root load composition", () => {
  // Renderer that only echoes what the real root load would hand the page.
  const echoRoot = (e: HookEventLike) => {
    const data = rootLoad({ locals: e.locals as Record<string, unknown> });
    return html(`<!doctype html><html><body><main>${JSON.stringify(data)}</main></body></html>`);
  };

  it("passes the verified bit through the real root load without any session store", async () => {
    const sessionFor = vi.fn(async () => {
      throw new Error("public notice must not wait on the session store");
    });
    const request = req({ ...NAV, "cf-ray": RAY, cookie: await signed("restored|/events/42") });
    let seen: Record<string, unknown> | undefined;
    const res = await dispatch(
      request,
      (e) => {
        seen = rootLoad({ locals: e.locals as Record<string, unknown> });
        return echoRoot(e);
      },
      { sessionFor },
    );
    expect(sessionFor).not.toHaveBeenCalled();
    expect(seen).toEqual({ requestId: RAY, restoredWrite: true });
    const body = await res.text();
    expect(body).not.toContain("/events/42");
    expect(body).not.toContain("session");
    // No auth-error marker rendered, so the one-shot cookie stays pending.
    expect(res.headers.getSetCookie().join("\n")).not.toContain(EXPIRED_WRITE_COOKIE);
  });

  it("nulling the root prop would be caught: unverified values reach the page as false", async () => {
    for (const value of ["pending|/events/42", "restored|//evil.test"]) {
      let seen: Record<string, unknown> | undefined;
      await dispatch(req({ ...NAV, cookie: await signed(value) }), (e) => {
        seen = rootLoad({ locals: e.locals as Record<string, unknown> });
        return echoRoot(e);
      });
      expect(seen?.restoredWrite).toBe(false);
    }
    let seen: Record<string, unknown> | undefined;
    await dispatch(req({ ...NAV, cookie: `${await signed("restored|/events/42")}x` }), (e) => {
      seen = rootLoad({ locals: e.locals as Record<string, unknown> });
      return echoRoot(e);
    });
    expect(seen?.restoredWrite).toBe(false);
  });

  it("keeps real root data notice-free and private for cookie-bearing JSON requests", async () => {
    for (const cookie of [undefined, await signed("restored|/private-destination")]) {
      let data: Record<string, unknown> | undefined;
      const response = await dispatch(
        req(cookie ? { cookie } : {}),
        (event) => {
          data = rootLoad({ locals: event.locals as Record<string, unknown> });
          return new Response(JSON.stringify(data), {
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=3600",
            },
          });
        },
        {},
        true,
      );
      expect(data?.restoredWrite).toBe(false);
      expect(await response.text()).not.toContain("private-destination");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.get("cache-control")).toBe(
        cookie ? "private, no-store" : "public, max-age=3600",
      );
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("ignores a forged locals.restoredWrite from the event", async () => {
    const request = req(NAV);
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/about" },
      locals: { restoredWrite: true },
    };
    let seen: unknown;
    await dispatchHookRequest(event, {
      appUrl: APP_URL,
      sessionSecret: SECRET,
      manifest: [{ method: "GET", path: "/about", enabled: true, reads: "public" }],
      honoFetch: async () => new Response("no", { status: 500 }),
      resolve: async (e) => {
        seen = rootLoad({ locals: (e as HookEventLike).locals as Record<string, unknown> });
        return html();
      },
    });
    expect(seen).toMatchObject({ restoredWrite: false });
  });
});

describe("dispatch: release boundary and caching", () => {
  const restoredNav = async (headers: Record<string, string> = {}, path = "/about") =>
    req({ ...NAV, "cf-ray": RAY, ...headers, cookie: await signed("restored|/events/42") }, path);
  const pending = (res: Response) =>
    expect(res.headers.getSetCookie().join("\n")).not.toContain(EXPIRED_WRITE_COOKIE);

  it("metadata-less archive pagination retains the notice until a document navigation", async () => {
    const cookie = await signed("restored|/events/42");
    const render = (event: HookEventLike) => {
      const data = rootLoad({ locals: event.locals as Record<string, unknown> });
      return html(
        data.restoredWrite
          ? FULL_HTML
          : "<!doctype html><html><body><main>Archive</main></body></html>",
      );
    };
    const fragment = await dispatch(
      req({ accept: "text/html", "x-two-island": "past-events", cookie }, "/events/past?page=2"),
      render,
    );
    expect(fragment.status).toBe(200);
    expect(await fragment.text()).not.toContain('data-testid="auth-error"');
    expect(fragment.headers.get("cache-control")).toBe("private, no-store");
    pending(fragment);

    // No deletion was returned by pagination, so the browser sends the same
    // signed cookie on the next full navigation (also without Fetch Metadata).
    const document = await dispatch(req({ accept: "text/html", cookie }, "/events/past"), render);
    expect(document.status).toBe(200);
    expect(await document.text()).toBe(FULL_HTML);
    expect(document.headers.getSetCookie().join("\n")).toContain(`${EXPIRED_WRITE_COOKIE}=`);
    expect(document.headers.getSetCookie().join("\n")).toMatch(/Max-Age=0/i);
    expect(document.headers.get("cache-control")).toBe("private, no-store");
  });

  it("consumes the cookie on a released full-document 200 with the marker", async () => {
    const res = await dispatch(await restoredNav(), () =>
      html(FULL_HTML, {
        headers: {
          etag: 'W/"abc"',
          "cache-control": "public, max-age=60",
          vary: "Accept-Encoding",
          "set-cookie": "other=1; Path=/; HttpOnly",
        },
      }),
    );
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const deletion = cookies.find((c) => c.startsWith(`${EXPIRED_WRITE_COOKIE}=`))!;
    expect(deletion).toBeDefined();
    expect(deletion).toMatch(/Max-Age=0/i);
    expect(deletion).toMatch(/Path=\//);
    expect(deletion).toMatch(/Secure/i);
    expect(deletion).toMatch(/HttpOnly/i);
    expect(deletion).toMatch(/SameSite=Lax/i);
    expect(deletion).not.toContain("/events/42");
    expect(cookies).toContain("other=1; Path=/; HttpOnly");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.has("etag")).toBe(false);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.text()).toBe(FULL_HTML);
  });

  it("leaves the cookie pending for every non-rendered notice shape", async () => {
    const cases: Array<[string, () => Response, Record<string, string>?, string?, boolean?]> = [
      ["no marker", () => html("<!doctype html><html><body><main>hi</main></body></html>")],
      ["fragment", () => html(MARKER)],
      ["json", () => new Response('{"a":1}', { headers: { "content-type": "application/json" } })],
      ["error 500", () => html(FULL_HTML, { status: 500 })],
      ["304", () => new Response(null, { status: 304 })],
      ["island", () => html(FULL_HTML), { "x-two-island": "1" }],
      [
        "archive fetch",
        () => html(FULL_HTML),
        { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
      ],
      ["data request", () => html(FULL_HTML), {}, "/about", true],
    ];
    for (const [name, make, headers, path, data] of cases) {
      const res = await dispatch(await restoredNav(headers, path), make, {}, data === true);
      expect(res.status, name).toBe(make().status);
      pending(res);
      if (res.status === 200 && (res.headers.get("content-type")?.includes("text/html") || data))
        expect(res.headers.get("cache-control"), name).toBe("private, no-store");
    }
  });

  it("never consumes on non-GET, auth paths, encoded auth paths or same-origin refusal", async () => {
    pending(await dispatch(await restoredNav({}, "/auth/error"), () => html()));
    pending(await dispatch(await restoredNav({}, "/%61uth/error"), () => html()));
    const post = await dispatch(
      new Request(new URL("/about", APP_URL).href, {
        method: "POST",
        headers: { host: "next.example.test", origin: "https://evil.example", ...NAV },
      }),
      () => html(),
    );
    pending(post);
  });

  it("varies clean public documents on Cookie, keeping existing Vary", async () => {
    const res = await dispatch(req(NAV), () =>
      html(FULL_HTML, { headers: { vary: "Accept-Encoding" } }),
    );
    const vary = (res.headers.get("vary") ?? "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim());
    for (const name of ["accept-encoding", "cookie"]) expect(vary).toContain(name);
    expect(res.headers.getSetCookie().join("\n")).not.toContain(EXPIRED_WRITE_COOKIE);
  });
});
