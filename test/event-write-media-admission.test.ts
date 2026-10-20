// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// Media-type admission for moderator event writes. Hermetic: the store, the
// public read-back and the write-back dispatch are test doubles, the session
// reader is injected, and ADMIN_DB is a proxy that throws if any SQL runs.
// Contract: an unsupported or genuinely absent Content-Type is refused with
// 415 before any create/update (and therefore before audit or sync dispatch),
// while exact JSON and the native form media types keep working in any case
// with parameters. The 415 response body shape is intentionally not pinned;
// only the status and the absence of side effects are the contract here.
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
const KEY = "01J0000000000000000000ABCD";
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
  purpose: null,
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
const member: Session = { ...moderator, id: "event-member", moderator: false };
let who: Session | null = moderator;

const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => who,
  async () => who,
);

function saved(input: EventFormInput): typeof events.$inferSelect {
  const { startsAtUtc, endsAtUtc, ...fields } = input;
  return { ...row, ...fields, startsAt: startsAtUtc, endsAt: endsAtUtc };
}

beforeEach(() => {
  vi.clearAllMocks();
  who = moderator;
  vi.mocked(getEvent).mockResolvedValue(row);
  vi.mocked(createEvent).mockImplementation(async (_db, _actor, input) => ({
    row: saved(input),
    writeBack: null,
  }));
  vi.mocked(updateEvent).mockImplementation(async (_db, _actor, _key, input) => {
    const updated = saved(input);
    vi.mocked(getPublicEvent).mockResolvedValue({ ...updated, goingCount: 0, goingOccupancy: 0 });
    // Non-null so a successful PATCH must dispatch exactly one write-back.
    return { row: updated, writeBack: { eventKey: KEY, status: "published" }, childWriteBacks: [] };
  });
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
  expect(dispatchWriteBack).not.toHaveBeenCalled();
}

async function responseTitle(res: Response): Promise<string> {
  return ((await res.json()) as { data: { title: string } }).data.title;
}

const createPayload = {
  title: "Game night",
  game: "Chess",
  description: "Bring a board",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
  timezone: "Europe/London",
  location: "Voice",
  capacity: 8,
};

// Each body would be a real (or parseable) write if it were misread as JSON or
// as a form; admission must refuse it on the declared media type alone, before
// body completeness matters at all.
const unsupported = [
  ["text/plain with a form-looking body", "title=Smuggled", "text/plain"],
  ["text/plain with a JSON body", '{"title":"Smuggled"}', "text/plain; charset=utf-8"],
  ["text/html", "<p>Smuggled</p>", "text/html"],
  ["application/xml", "<event><title>Smuggled</title></event>", "application/xml"],
  ["application/octet-stream", '{"title":"Smuggled"}', "application/octet-stream"],
  ["a +json vendor type", '{"title":"Smuggled"}', "application/vnd.api+json"],
  ["a JSON substring lookalike", '{"title":"Smuggled"}', "application/jsonx"],
  [
    "a JSON Patch media type",
    '[{"op":"replace","path":"/title","value":"Smuggled"}]',
    "application/json-patch+json",
  ],
  ["a form substring lookalike", "title=Smuggled", "application/x-www-form-urlencodedx"],
  ["a multipart substring lookalike", "title=Smuggled", "multipart/form-datax; boundary=x"],
] as const;

for (const method of ["POST", "PATCH"] as const) {
  describe(`${method} media-type admission`, () => {
    it.each(unsupported)(
      "refuses %s with 415 and no mutation, audit or dispatch",
      async (_label, body, contentType) => {
        const res = await write(method, body, contentType);
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

    it("keeps malformed JSON a 422 with no side effects", async () => {
      const res = await write(method, '{"title":', "application/json");
      expect(res.status).toBe(422);
      expectNoMutationOrDispatch();
    });

    it("keeps a malformed multipart body a 422 with no side effects", async () => {
      const res = await write(method, "garbage", "multipart/form-data; boundary=x");
      expect(res.status).toBe(422);
      expectNoMutationOrDispatch();
    });

    it("authentication refusal precedes media-type admission", async () => {
      who = null;
      const res = await write(method, '{"title":"Smuggled"}', "text/plain");
      expect(res.status).toBe(401);
      expectNoMutationOrDispatch();
    });

    it("moderator authorization precedes media-type admission", async () => {
      who = member;
      const res = await write(method, '{"title":"Smuggled"}', "text/plain");
      expect(res.status).toBe(403);
      expectNoMutationOrDispatch();
    });

    it("the existing body-size refusal precedes media-type admission", async () => {
      const res = await write(method, "x".repeat(32 * 1024 + 1), "text/plain");
      expect(res.status).toBe(413);
      expectNoMutationOrDispatch();
    });
  });
}

describe("supported media types still write", () => {
  it.each([
    ["application/json", '{"title":"Renamed"}', "Renamed"],
    ["Application/Json; charset=utf-8", '{"title":"Renamed"}', "Renamed"],
    ["application/x-www-form-urlencoded", "title=Form+edit", "Form edit"],
    ["Application/X-Www-Form-Urlencoded; charset=UTF-8", "title=Form+edit", "Form edit"],
  ] as const)("PATCH admits %s, updates once and dispatches once", async (ct, body, title) => {
    const res = await write("PATCH", body, ct);
    expect(res.status).toBe(200);
    expect(await responseTitle(res)).toBe(title);
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWriteBack).toHaveBeenCalledTimes(1);
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("PATCH keeps the explicit application/json {} contract", async () => {
    const res = await write("PATCH", "{}", "application/json; charset=utf-8");
    expect(res.status).toBe(200);
    expect(await responseTitle(res)).toBe("Game night");
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWriteBack).toHaveBeenCalledTimes(1);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("PATCH admits a native multipart form body", async () => {
    const form = new FormData();
    form.set("title", "Multipart edit");
    const res = await write("PATCH", form);
    expect(res.status).toBe(200);
    expect(await responseTitle(res)).toBe("Multipart edit");
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWriteBack).toHaveBeenCalledTimes(1);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("PATCH admits multipart in mixed case with parameters", async () => {
    const boundary = "----media-boundary";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n` +
      `Multipart edit\r\n--${boundary}--\r\n`;
    const res = await write("PATCH", body, `Multipart/Form-Data; boundary=${boundary}`);
    expect(res.status).toBe(200);
    expect(await responseTitle(res)).toBe("Multipart edit");
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWriteBack).toHaveBeenCalledTimes(1);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("POST admits an exact JSON create", async () => {
    const res = await write("POST", JSON.stringify(createPayload), "application/json");
    expect(res.status).toBe(201);
    expect(await responseTitle(res)).toBe("Game night");
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("POST admits a urlencoded form create", async () => {
    const form = new URLSearchParams({
      ...createPayload,
      capacity: String(createPayload.capacity),
    });
    const res = await write("POST", form.toString(), "application/x-www-form-urlencoded");
    expect(res.status).toBe(201);
    expect(await responseTitle(res)).toBe("Game night");
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it("POST admits a multipart form create", async () => {
    const form = new FormData();
    for (const [field, value] of Object.entries(createPayload)) form.set(field, String(value));
    const res = await write("POST", form);
    expect(res.status).toBe(201);
    expect(await responseTitle(res)).toBe("Game night");
    expect(createEvent).toHaveBeenCalledTimes(1);
  });
});
