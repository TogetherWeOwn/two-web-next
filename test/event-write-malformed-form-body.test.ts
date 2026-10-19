// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// Malformed-body admission for moderator event writes: exact refusal messages.
// Hermetic: the store, the public read-back and the write-back dispatch are
// test doubles, the session reader is injected, and ADMIN_DB is a proxy that
// throws if any SQL runs (same shape as test/event-write-media-admission.test.ts).
// Contract: a malformed multipart form body is a 422 with the exact
// "Send a valid form body." message — never an empty PATCH that gets written,
// audited, and re-synced to Discord; malformed/non-object JSON is a 422 with
// the exact "Send a JSON object." message; unknown media types are 415. All
// three refuse before any create/update (and therefore before audit or sync
// dispatch). The bare mount carries no requestLog context, so the 422 envelope
// has no request_id key (same rule as test/event-profile-422-request-id.test.ts).
// The final negative control routes the same malformed bytes through the
// permissive empty-default parser and proves they become an empty write:
// that is the trap the `onMalformedForm: "throw"` opt-in closes.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import {
  createEvent,
  getEvent,
  mergePatchInput,
  patchEvent,
  updateEvent,
} from "../src/admin/store";
import type { EventFormInput } from "../src/admin/validation";
import { dispatchWriteBack } from "../src/admin/writeback";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { body as parseBody } from "../src/events/routes-shared";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  patchEvent: vi.fn(),
  updateEvent: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
}));
vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const row = {
  id: 1,
  eventKey: KEY,
  title: "Game night",
  game: "Chess",
  description: "Bring a board",
  location: "Voice",
  timezone: "Europe/London",
  capacity: 8,
  // Winter in London: wall time equals UTC, so merged PATCH defaults are exact.
  startsAt: new Date("2030-01-01T18:00:00Z"),
  endsAt: new Date("2030-01-01T19:00:00Z"),
  discordEventId: "123456789012345678",
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  status: "published",
  rsvpOpen: false,
  createdBy: "event-moderator",
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies typeof events.$inferSelect;

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

const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => moderator,
  async () => moderator,
);

// Test-only harness, not a production route: parses with the permissive
// empty-default (no `onMalformedForm: "throw"`) and writes whatever comes
// out. A malformed form must arrive here as `{}` and be written + dispatched;
// the production routes must never let that happen.
const permissive = new Hono<{ Bindings: EnvWithAdminDb }>();
permissive.patch("/control/:key", async (c) => {
  const patch = await parseBody(c);
  const db = c.env.ADMIN_DB;
  if (!db) throw new Error("control harness needs ADMIN_DB");
  const { row: updated } = await patchEvent(
    db,
    { id: moderator.id, username: moderator.username },
    c.req.param("key"),
    patch,
  );
  await dispatchWriteBack(c.env, { eventKey: updated.eventKey, status: "published" }, undefined);
  return c.json({ patched: patch });
});

function saved(input: EventFormInput): typeof events.$inferSelect {
  const { startsAtUtc, endsAtUtc, ...fields } = input;
  return { ...row, ...fields, startsAt: startsAtUtc, endsAt: endsAtUtc };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(row);
  vi.mocked(createEvent).mockImplementation(async (_db, _actor, input) => ({
    row: saved(input),
    writeBack: null,
  }));
  // PATCH merges through the real pure seam against the fixture row (no SQL),
  // so admission pins keep exercising production validation.
  vi.mocked(patchEvent).mockImplementation(async (_db, _actor, _key, patch) => {
    const updated = saved(mergePatchInput(row, patch));
    vi.mocked(getPublicEvent).mockResolvedValue({ ...updated, goingCount: 0, goingOccupancy: 0 });
    return { row: updated, writeBack: { eventKey: KEY, status: "published" }, childWriteBacks: [] };
  });
});

type Method = "POST" | "PATCH";
const pathFor = (method: Method) => (method === "POST" ? "/events" : `/events/${KEY}`);

async function write(method: Method, body: BodyInit, contentType?: string): Promise<Response> {
  return app.request(
    pathFor(method),
    {
      method,
      headers: contentType === undefined ? {} : { "content-type": contentType },
      body,
    },
    env,
  );
}

/** A request whose bytes carry no Content-Type header at all. */
async function writeWithoutContentType(method: Method, bodyText: string): Promise<Response> {
  const req = new Request(new URL(pathFor(method), APP_URL), {
    method,
    body: new TextEncoder().encode(bodyText),
  });
  expect(req.headers.get("content-type")).toBeNull();
  return app.request(req, undefined, env);
}

function expectNoMutationOrDispatch() {
  expect(createEvent).not.toHaveBeenCalled();
  expect(patchEvent).not.toHaveBeenCalled();
  expect(updateEvent).not.toHaveBeenCalled();
  expect(getPublicEvent).not.toHaveBeenCalled();
  expect(dispatchWriteBack).not.toHaveBeenCalled();
}

async function expectExact422(res: Response, message: string) {
  expect(res.status).toBe(422);
  // Exact envelope: the bare mount has no requestLog context, so no
  // request_id key is carried (additive-correlation rule).
  expect(await res.json()).toEqual({ error: "invalid", fields: { body: message } });
  expectNoMutationOrDispatch();
}

// Every shape that is not a JSON object: malformed bytes, empty bytes, and
// each JSON scalar/array spelling. Mirrors the DB-level invalidBodies in
// test/event-patch-admission.test.ts so the hermetic pins cannot drift
// from the suite that proves no row, audit, or sync write happened.
const nonObjectJson = [
  ["malformed JSON", '{"title":'],
  ["empty JSON", ""],
  ["null", "null"],
  ["empty array", "[]"],
  ["array of objects", '[{"title":"Changed"}]'],
  ["string", '"Changed"'],
  ["number", "42"],
  ["boolean", "true"],
] as const;

const unsupported = [
  ["text/plain", "title=Smuggled", "text/plain; charset=utf-8"],
  ["application/xml", "<event><title>Smuggled</title></event>", "application/xml"],
  ["a +json vendor type", '{"title":"Smuggled"}', "application/vnd.api+json"],
] as const;

for (const method of ["POST", "PATCH"] as const) {
  describe(`${method} malformed-body admission`, () => {
    it("refuses a malformed multipart body with the exact form message and no writes", async () => {
      // A garbage multipart body must never become an empty write: PATCH must
      // not rewrite the row, log, or enqueue a Discord re-sync for a request
      // the server could not parse.
      const res = await write(method, "garbage", "multipart/form-data; boundary=x");
      await expectExact422(res, "Send a valid form body.");
    });

    it("refuses a truncated multipart body with the exact form message and no writes", async () => {
      const res = await write(
        method,
        '------boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\nTrunca',
        "multipart/form-data; boundary=----boundary",
      );
      await expectExact422(res, "Send a valid form body.");
    });

    it.each(nonObjectJson)(
      "refuses %s with the exact JSON message and no writes",
      async (_, text) => {
        const res = await write(method, text, "application/json");
        await expectExact422(res, "Send a JSON object.");
      },
    );

    it.each(unsupported)(
      "refuses %s with 415 and no mutation, audit or dispatch",
      async (_label, text, contentType) => {
        const res = await write(method, text, contentType);
        expect(res.status).toBe(415);
        expectNoMutationOrDispatch();
      },
    );

    it("refuses a body with no Content-Type header with 415 and no side effects", async () => {
      const res = await writeWithoutContentType(method, '{"title":"Smuggled"}');
      expect(res.status).toBe(415);
      expectNoMutationOrDispatch();
    });

    it("refuses an empty Content-Type header with 415 and no side effects", async () => {
      const res = await write(method, new TextEncoder().encode('{"title":"Smuggled"}'), "");
      expect(res.status).toBe(415);
      expectNoMutationOrDispatch();
    });
  });
}

describe("controls", () => {
  it("PATCH still admits a valid multipart form body (control)", async () => {
    const form = new FormData();
    form.set("title", "Multipart edit");
    const res = await write("PATCH", form);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { title: string } }).data.title).toBe("Multipart edit");
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWriteBack).toHaveBeenCalledTimes(1);
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("negative control: the same malformed bytes through the empty-default parser become an empty write", async () => {
    // Without `onMalformedForm: "throw"` the malformed multipart body parses
    // to `{}`, the empty PATCH merges cleanly against the stored row, and the
    // nothing-changed edit is written and dispatched — the exact failure the
    // production 422 pins above exist to prevent.
    const res = await permissive.request(
      `/control/${KEY}`,
      {
        method: "PATCH",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "garbage",
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ patched: {} });
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(patchEvent).mock.calls[0]![3]).toEqual({});
    expect(dispatchWriteBack).toHaveBeenCalledTimes(1);
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
