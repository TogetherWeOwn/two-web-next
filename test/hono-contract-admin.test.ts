// Missing wire cases only: existing operator, body-cap and admin guard suites
// own the happy paths, token validation, explicit method sets and cap ordering.
// These are in-process pure-Hono characterizations, not Worker or Kit parity.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, createFeatured } from "../src/admin/store";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import app from "../src/index";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const sqlOpened = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({
  default: (...args: unknown[]) => {
    sqlOpened(...args);
    throw new Error("contract fixtures must not open SQL");
  },
}));
vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  createFeatured: vi.fn(),
}));

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONTROL_TOKEN = "test-admin-contract-control-token-not-a-real-secret";
const EVIDENCE_TOKEN = "test-admin-contract-evidence-token-not-a-real-secret";
const PRIVATE = "synthetic submitted title must not be admitted";
const dbTouched = vi.fn(() => {
  throw new Error("contract fixtures must not query SQL");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;
const throttleStore = vi.fn(async () => null);
const send = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("contract fixtures must remain offline"))),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(sqlOpened).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
  expect(createEvent).not.toHaveBeenCalled();
  expect(createFeatured).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(
  principal: "guest" | "member" | "moderator",
  withDb = false,
  target: typeof app = app,
) {
  const sessions = createMemorySessionStore();
  const cookie =
    principal === "guest"
      ? ""
      : await cookieFor(sessions, principal === "member" ? MEMBER : MODERATOR);
  const get = vi.spyOn(sessions, "get");
  const rotate = vi.spyOn(sessions, "rotate");
  const bindings = {
    ...env,
    APP_URL: STAGING_APP_URL,
    SESSION_STORE: sessions,
    ...(withDb ? { ADMIN_DB: db } : {}),
    THROTTLE_STORE: throttleStore,
    SYNC_EVENT_QUEUE: { send },
    OPS_CONTROL_TOKEN: CONTROL_TOKEN,
    SOURCE_EVIDENCE_VERIFIER_ENABLED: "true",
    SOURCE_EVIDENCE_VERIFIER_TOKEN: EVIDENCE_TOKEN,
    SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: "7",
    SOURCE_EVIDENCE_VERIFIER_ISSUED_AT: String(Date.now()),
    SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: String(Date.now() + 600_000),
    QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
    QUEUE_RECONCILE_OPERATOR_ID: MODERATOR.userId,
  } as Env;
  return {
    get,
    rotate,
    request: (path: string, init: RequestInit = {}) =>
      target.request(
        `${STAGING_APP_URL}${path}`,
        {
          ...init,
          headers: { cookie, origin: STAGING_APP_URL, ...init.headers },
        },
        bindings,
      ),
  };
}

// Mutate only a fresh in-memory route table; neither the real app nor runtime
// source is edited. These controls prove the observations depend on the gate
// and on the bearer registrations preceding it, not just a generic refusal.
describe("local registration mutation controls", () => {
  it("detects moving the control route behind the moderator gate", async () => {
    const mutant = new Hono<{ Bindings: Env }>();
    const controls = app.routes.filter((route) => route.path === "/admin/ops-overrides");
    expect(controls.length).toBeGreaterThan(0);
    for (const route of [...app.routes.filter((route) => !controls.includes(route)), ...controls]) {
      mutant.on(route.method, route.path, route.handler);
    }
    const native = await fixture("member");
    const moved = await fixture("member", false, mutant);
    expect((await native.request("/admin/ops-overrides")).status).toBe(401);
    expect((await moved.request("/admin/ops-overrides")).status).toBe(403);
    expect(native.get).not.toHaveBeenCalled();
    expect(moved.get).toHaveBeenCalledTimes(1);
    expect(throttleStore).not.toHaveBeenCalled();
  });

  it("detects removal of the moderator gate on an unsupported method", async () => {
    const mutant = new Hono<{ Bindings: Env }>();
    expect(app.routes.some((route) => route.path === "/admin/*")).toBe(true);
    for (const route of app.routes.filter((route) => route.path !== "/admin/*")) {
      mutant.on(route.method, route.path, route.handler);
    }
    const native = await fixture("guest");
    const ungated = await fixture("guest", false, mutant);
    const init = { method: "DELETE", headers: { accept: "application/json" } };
    expect((await native.request("/admin/featured/7", init)).status).toBe(401);
    expect((await ungated.request("/admin/featured/7", init)).status).toBe(404);
    expect(throttleStore).not.toHaveBeenCalled();
  });
});

const representations = [
  { accept: "text/html", contentType: "text/plain" },
  { accept: "application/json", contentType: "application/json" },
];

describe.each(representations)(
  "bearer refusals with Accept: $accept",
  ({ accept, contentType }) => {
    it.each(["member", "moderator"] as const)(
      "%s cookies cannot replace the control/evidence bearer or change explicit 405s",
      async (principal) => {
        const f = await fixture(principal);
        for (const row of [
          { path: "/admin/ops-overrides", status: 401, media: "text/html" },
          { path: "/admin/queue/source-evidence/7", status: 403, media: "application/json" },
        ]) {
          const res = await f.request(row.path, { headers: { accept } });
          expect(res.status, row.path).toBe(row.status);
          expect(res.headers.get("content-type")).toContain(row.media);
          expect(res.headers.get("location")).toBeNull();
          expect(res.headers.get("cache-control")).toBe("private, no-store");
          expect(res.headers.get("set-cookie")).toBeNull();
          if (row.status === 401) {
            expect(res.headers.get("www-authenticate")).toBe("Bearer");
            expect(await res.text()).toContain("Operator access required");
          } else {
            expect(await res.json()).toEqual({ error: "evidence_forbidden" });
          }
        }
        for (const [path, allow] of [
          ["/admin/ops-overrides", "GET, HEAD"],
          ["/admin/queue/source-evidence/7", "GET"],
        ]) {
          const res = await f.request(path!, {
            method: "POST",
            headers: { accept, "content-type": contentType },
            body: "not a form",
          });
          expect(res.status, path).toBe(405);
          expect(res.headers.get("allow")).toBe(allow);
          expect(res.headers.get("content-type")).toContain("application/json");
          expect(res.headers.get("cache-control")).toBe("private, no-store");
          expect(res.headers.get("set-cookie")).toBeNull();
          expect(await res.json()).toEqual({ error: "method_not_allowed" });
        }
        expect(f.get).not.toHaveBeenCalled();
        expect(f.rotate).not.toHaveBeenCalled();
        expect(throttleStore).not.toHaveBeenCalled();
      },
    );
  },
);

// No handler is registered for these methods. Hono runs the moderator gate
// before its 404, not a framework-wide 405 or a bearer fallback.
const unsupported = [
  { method: "PUT", path: "/admin" },
  { method: "PATCH", path: `/admin/events/${KEY}` },
  { method: "DELETE", path: "/admin/featured/7" },
  { method: "OPTIONS", path: `/admin/events/${KEY}/publish` },
];

describe.each(["guest", "member", "moderator"] as const)(
  "%s on unregistered admin wires",
  (principal) => {
    it.each(unsupported)(
      "$method $path stays behind the session guard",
      async ({ method, path }) => {
        const f = await fixture(principal);
        const res = await f.request(path, {
          method,
          // Even the valid operator credential does not authorize session routes.
          headers: { authorization: `Bearer ${CONTROL_TOKEN}`, accept: "application/json" },
        });
        expect(res.status).toBe(principal === "guest" ? 401 : principal === "member" ? 403 : 404);
        expect(res.headers.get("allow")).toBeNull();
        expect(res.headers.get("location")).toBeNull();
        if (principal === "guest") {
          expect(await res.json()).toMatchObject({ error: "unauthenticated" });
        }
        if (principal === "moderator") {
          expect(res.headers.get("content-type")).toContain("text/html");
          expect(await res.text()).toContain("We cannot find that page");
        }
        if (principal === "guest") expect(f.get).not.toHaveBeenCalled();
        else expect(f.get).toHaveBeenCalledTimes(1);
        expect(f.rotate).not.toHaveBeenCalled();
        expect(throttleStore).not.toHaveBeenCalled();
      },
    );

    it.each([
      "/admin/__data.json",
      "/admin/events/__data.json",
      "/admin/events/",
      "/admin/ops-overrides/",
      "/admin/ops-overrides/__data.json",
      "/admin/queue/source-evidence/7/",
      "/admin/queue/source-evidence/7/__data.json",
      "/admin/queue/failed/7/preview/",
      "/admin/queue/failed/7/preview/__data.json",
    ])("GET %s is not an alternate bearer or data endpoint", async (path) => {
      const f = await fixture(principal, path === "/admin/events/__data.json");
      const res = await f.request(path, {
        headers: { authorization: `Bearer ${CONTROL_TOKEN}`, accept: "application/json" },
      });
      expect(res.status).toBe(principal === "guest" ? 302 : principal === "member" ? 403 : 404);
      expect(res.headers.get("allow")).toBeNull();
      expect(res.headers.get("location")).toBe(principal === "guest" ? "/auth/discord" : null);
      if (principal === "guest") expect(f.get).not.toHaveBeenCalled();
      else expect(f.get).toHaveBeenCalled();
      if (principal === "moderator") {
        expect(res.headers.get("cache-control")).toContain("no-store");
        expect(await res.text()).not.toContain("Operator overrides");
        expect(f.rotate).toHaveBeenCalledTimes(1);
      }
      expect(throttleStore).not.toHaveBeenCalled();
    });
  },
);

// Hono parseBody ignores non-form media. With a configured fixture DB these
// create routes validate empty fields and render 422 HTML, even for JSON Accept;
// this records current behavior, not approval of a future Kit 415 difference.
describe.each(representations)(
  "non-form creates with Accept: $accept",
  ({ accept, contentType }) => {
    it.each(["/admin/events", "/admin/featured"])(
      "POST %s validates empty form values rather than decoding the non-form body",
      async (path) => {
        const f = await fixture("moderator", true);
        const res = await f.request(path, {
          method: "POST",
          headers: { accept, "content-type": contentType },
          body: JSON.stringify({ title: PRIVATE }),
        });
        expect(res.status).toBe(422);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("location")).toBeNull();
        const html = await res.text();
        expect(html).toContain(
          path === "/admin/events" ? "Give the event a title." : "Give it a headline.",
        );
        expect(html).toMatch(/name="title"[^>]*value=""/);
        expect(html).not.toContain(PRIVATE);
        expect(f.get).toHaveBeenCalledTimes(1);
        expect(f.rotate).not.toHaveBeenCalled();
        expect(throttleStore).toHaveBeenCalledTimes(1);
      },
    );
  },
);
