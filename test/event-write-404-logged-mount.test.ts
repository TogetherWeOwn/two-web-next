// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: POST /events/:key/duplicate
// Logged-mount pin for the moderator event-write 404s (src/events/routes-writes.ts):
// the PATCH NotFoundError catch, the transition and duplicate forged-key
// pre-checks, and the transition and duplicate NotFoundError catches must all
// answer { error: "not_found", request_id } where requestLog is mounted.
// The bare-mount omission ({ error } only) is pinned by
// test/event-write-route-key-admission.test.ts and the unified acceptance
// bare-mount controls; this file pins the logged direction those suites
// cannot see. A bare c.json revert at any of the five sites must fail here.
//
// Hermetic: the store writers, the public read-back and the write-back
// dispatch are test doubles (same shape as
// test/event-write-route-key-admission.test.ts), the session reader is
// injected, and ADMIN_DB is a proxy that throws if any SQL runs. Writer
// doubles have no default implementation: a request that reaches an
// unmocked writer 500s instead of passing by accident.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { NotFoundError, duplicateEvent, patchEvent, transitionEvent } from "../src/admin/store";
import { dispatchWriteBack } from "../src/admin/writeback";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent, withGoingCount } from "../src/events/reads";
import { registerWriteRoutes } from "../src/events/routes-writes";
import { requestLog } from "../src/request-log";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  patchEvent: vi.fn(),
  transitionEvent: vi.fn(),
  duplicateEvent: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
  withGoingCount: vi.fn(),
}));
vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const RAY = "0123456789abcdef-LHR";
const APP_URL = "https://next.example.test";
// Well-formed ULID the store does not know: passes eventKeyAllowed, then the
// writer double throws NotFoundError (unlike "forged", refused pre-store).
const UNKNOWN_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const env: EnvWithAdminDb = {
  APP_URL,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture",
  ADMIN_DB: new Proxy({} as Db, {
    get: (_, key) => {
      if (key === "then") return undefined;
      throw new Error("fixture must not query a DB");
    },
  }),
};

const moderator: Session = {
  id: "event-moderator",
  username: "mod",
  avatar: null,
  member: true,
  moderator: true,
};

const inner = new Hono<{ Bindings: Env }>();
registerWriteRoutes(inner, async () => moderator);
const app = new Hono<{ Bindings: Env }>();
app.use("*", requestLog);
app.route("/", inner);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("moderator event-write 404s carry request_id when logged", () => {
  it("PATCH unknown ULID 404s with request_id through the store", async () => {
    vi.mocked(patchEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    const res = await app.request(
      `/events/${UNKNOWN_ULID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-ray": RAY },
        body: JSON.stringify({ title: "Renamed" }),
      },
      env,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.json()).toEqual({ error: "not_found", request_id: RAY });
    expect(patchEvent).toHaveBeenCalledTimes(1);
  });

  it("POST publish forged key 404s with request_id before the store", async () => {
    const res = await app.request("/events/forged/publish", {
      method: "POST",
      headers: { "cf-ray": RAY },
    }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.json()).toEqual({ error: "not_found", request_id: RAY });
    expect(transitionEvent).not.toHaveBeenCalled();
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("POST publish unknown ULID 404s with request_id through the store", async () => {
    vi.mocked(transitionEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    const res = await app.request(`/events/${UNKNOWN_ULID}/publish`, {
      method: "POST",
      headers: { "cf-ray": RAY },
    }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.json()).toEqual({ error: "not_found", request_id: RAY });
    expect(transitionEvent).toHaveBeenCalledTimes(1);
  });

  it("POST duplicate forged key 404s with request_id before the store", async () => {
    const res = await app.request("/events/forged/duplicate", {
      method: "POST",
      headers: { "cf-ray": RAY },
    }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.json()).toEqual({ error: "not_found", request_id: RAY });
    expect(duplicateEvent).not.toHaveBeenCalled();
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("POST duplicate unknown ULID 404s with request_id through the store", async () => {
    vi.mocked(duplicateEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    const res = await app.request(`/events/${UNKNOWN_ULID}/duplicate`, {
      method: "POST",
      headers: { "cf-ray": RAY },
    }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.json()).toEqual({ error: "not_found", request_id: RAY });
    expect(duplicateEvent).toHaveBeenCalledTimes(1);
  });

  it("read-back and write-back doubles stay silent on every refused 404", async () => {
    vi.mocked(patchEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    vi.mocked(transitionEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    vi.mocked(duplicateEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    const patch = await app.request(
      `/events/${UNKNOWN_ULID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-ray": RAY },
        body: JSON.stringify({ title: "Renamed" }),
      },
      env,
    );
    const publish = await app.request(`/events/${UNKNOWN_ULID}/publish`, {
      method: "POST",
      headers: { "cf-ray": RAY },
    }, env);
    const duplicate = await app.request(`/events/${UNKNOWN_ULID}/duplicate`, {
      method: "POST",
      headers: { "cf-ray": RAY },
    }, env);
    for (const res of [patch, publish, duplicate]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", request_id: RAY });
    }
    expect(getPublicEvent).not.toHaveBeenCalled();
    expect(withGoingCount).not.toHaveBeenCalled();
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });
});
