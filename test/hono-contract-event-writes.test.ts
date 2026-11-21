// Missing RSVP admission and withdrawal ordering cases. Real mounted Hono
// routes and RSVP service, synthetic local DB/queue only. The producer seam
// matches rsvp-post-key-alias-acceptance; this is not Worker/SQL parity proof.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { registerRsvpRoutes } from "../src/events/routes-rsvp";
import { RSVP_HONEY_FIELD } from "../src/islands/contracts";
import type { QueueMessage } from "../src/jobs/types";
import { fakeRsvpDb } from "./helpers/fake-rsvp-db";

vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));

const APP_URL = "https://fixture.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER: Session = {
  id: "420000000000000042",
  username: "fixture-member",
  avatar: null,
  member: true,
  moderator: false,
};
const readSession = vi.fn(async () => MEMBER);
const send = vi.fn(async (_message: unknown) => {});
const app = new Hono<{ Bindings: Env }>();
registerRsvpRoutes(app, readSession);
const baseEnv = {
  APP_URL,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  SYNC_EVENT_QUEUE: { send },
} as unknown as Env;
const dbRead = vi.fn((): Db => {
  throw new Error("admission must not read the database");
});
const admissionEnv = {
  ...baseEnv,
  get ADMIN_DB() {
    return dbRead();
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

const rsvpRoutes = [
  ["PUT", `/events/${KEY}/rsvp`, 201],
  ["DELETE", `/events/${KEY}/rsvp`, 204],
  ["POST", `/e/${KEY}/rsvp`, 303],
] as const;

function formRequest(
  method: string,
  path: string,
  size: number,
  accept: string,
  advertised = false,
) {
  // Filled decoy is an under-cap positive control that never needs SQL.
  const prefix = `status=going&${RSVP_HONEY_FIELD}=fixture&padding=`;
  return new Request(new URL(path, APP_URL), {
    method,
    headers: {
      accept,
      "content-type": "application/x-www-form-urlencoded",
      ...(advertised ? { "content-length": String(size) } : {}),
    },
    body: prefix + "x".repeat(size - prefix.length),
  });
}

function expectNoEffects() {
  expect(readSession).not.toHaveBeenCalled();
  expect(dbRead).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
}

describe("registered RSVP body caps", () => {
  it.each(rsvpRoutes)(
    "%s %s counts streamed bytes before the decoy or store",
    async (method, path) => {
      const res = await app.request(
        formRequest(method, path, BODY_LIMIT_BYTES.action + 1, "application/json"),
        undefined,
        admissionEnv,
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ reason: "payload_too_large" });
      expectNoEffects();
    },
  );

  it.each(rsvpRoutes)(
    "%s %s rejects advertised overflow before reading a session",
    async (method, path) => {
      const res = await app.request(
        formRequest(method, path, BODY_LIMIT_BYTES.action + 1, "application/json", true),
        undefined,
        admissionEnv,
      );
      expect(res.status).toBe(413);
      expectNoEffects();
    },
  );

  it.each(rsvpRoutes)(
    "%s %s admits exactly the cap with route-native negotiation",
    async (method, path, status) => {
      for (const accept of ["application/json", "text/html"]) {
        const res = await app.request(
          formRequest(method, path, BODY_LIMIT_BYTES.action, accept),
          undefined,
          admissionEnv,
        );
        expect(res.status).toBe(status);
        if (method === "PUT") {
          expect(res.headers.get("content-type")).toContain("application/json");
          expect(await res.json()).toEqual({
            data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
          });
        } else if (method === "DELETE") {
          expect(await res.text()).toBe("");
        } else {
          expect(res.headers.get("location")).toBe(`/e/${KEY}`);
        }
        expectNoEffects();
      }
    },
  );

  it.each(["PUT", "DELETE"])("%s alias overflow wins over the canonical 308", async (method) => {
    const res = await app.request(
      formRequest(
        method,
        `/events/${KEY.toLowerCase()}/rsvp`,
        BODY_LIMIT_BYTES.action + 1,
        "application/json",
      ),
      undefined,
      admissionEnv,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("location")).toBeNull();
    expectNoEffects();
    // Under the cap the very same alias reaches the registered redirect.
    const control = await app.request(
      formRequest(
        method,
        `/events/${KEY.toLowerCase()}/rsvp`,
        BODY_LIMIT_BYTES.action,
        "application/json",
      ),
      undefined,
      admissionEnv,
    );
    expect(control.status).toBe(308);
    expect(control.headers.get("location")).toBe(`/events/${KEY}/rsvp`);
    expectNoEffects();
  });
});

it("caps and authorizes RSVP PUT before spending a budget, then commits before dispatching a waitlisted answer", async () => {
  const cap = BODY_LIMIT_BYTES.action;
  const eventId = 42;
  const handle = fakeRsvpDb({
    event: {
      id: eventId,
      eventKey: KEY,
      status: "published",
      rsvpOpen: true,
      endsAt: new Date(Date.now() + 3_600_000),
      capacity: 1,
    },
    existing: null,
    goingCount: 1,
    rejectPromotionLookup: true,
    throttleCount: { n: 0, wait: 1 },
    waitlistRank: { event_id: eventId, user_id: MEMBER.id, position: 2 },
    finalRow: () => ({ status: handle.inserted[0]?.status, syncedToDiscordAt: null }),
  });

  const transaction = vi.fn(async (fn: Parameters<Db["transaction"]>[0]) =>
    handle.db.transaction(fn),
  );
  let committed = false;
  const commitAtDispatch: boolean[] = [];
  const queueSend = vi.fn(async (_message: unknown) => {
    commitAtDispatch.push(committed);
  });
  const env = {
    ...baseEnv,
    ADMIN_DB: { transaction } as unknown as Db,
    SYNC_EVENT_QUEUE: { send: queueSend },
  };
  const request = (size: number) => {
    const prefix = "status=going&padding=";
    return app.request(
      `/events/${KEY}/rsvp`,
      {
        method: "PUT",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: prefix + "x".repeat(size - prefix.length),
      },
      env,
    );
  };

  readSession.mockResolvedValueOnce({ ...MEMBER, member: false });
  const oversized = await request(cap + 1);
  expect(oversized.status).toBe(413);
  expect(readSession).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(queueSend).not.toHaveBeenCalled();

  const forbidden = await request(cap);
  expect(readSession).toHaveBeenCalledOnce();
  expect(transaction).not.toHaveBeenCalled();
  expect(queueSend).not.toHaveBeenCalled();
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({ error: "forbidden" });

  // Fence only the accepted request so refusal regressions fail without waiting for commit.
  let reachedCommit!: () => void;
  let releaseCommit!: () => void;
  const atCommit = new Promise<void>((resolve) => {
    reachedCommit = resolve;
  });
  const commitFence = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  transaction.mockImplementationOnce(async (fn) => {
    const result = await handle.db.transaction(fn);
    reachedCommit();
    await commitFence;
    committed = true;
    return result;
  });
  const pending = Promise.resolve(request(cap));
  try {
    await Promise.race([
      atCommit,
      pending.then((response) => {
        throw new Error(`RSVP answered ${response.status} before reaching commit`);
      }),
    ]);
    expect(transaction).toHaveBeenCalledOnce();
    expect(handle.inserted).toMatchObject([{ eventId, userId: MEMBER.id, status: "waitlisted" }]);
    expect(queueSend).not.toHaveBeenCalled();
  } finally {
    releaseCommit();
  }
  const accepted = await pending;
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toEqual({
    data: { status: "waitlisted", synced_to_discord_at: null, waitlist_position: 2 },
  });
  expect(commitAtDispatch).toEqual([true]);
  expect(queueSend).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "sync-event", eventKey: KEY }),
    { delaySeconds: 10 },
  );
});

// A scripted withdrawal transaction, following the existing RSVP DB-double
// pattern. A paused published event avoids unrelated waitlist promotion. Row
// deletion is staged until the transaction resolves; the fence lets the test
// observe that neither the response nor queue send escapes before commit.
function withdrawalFixture(options: { exists?: boolean; limited?: boolean } = {}) {
  const trace: string[] = [];
  let deleted = false;
  let stagedDelete = false;
  let release!: () => void;
  let ready!: () => void;
  const commitFence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readyToCommit = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const event = { id: 42, eventKey: KEY, status: "published", rsvpOpen: false };
  const tx = {
    execute: async () => [{ n: options.limited ? 12 : 0, wait: 7 }],
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          for: async () => (projection ? [{ id: 1 }] : [event]),
          limit: async () => [{ now: new Date("2030-01-01T12:00:00Z") }],
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (options.exists === false) return [];
          stagedDelete = true;
          trace.push("delete-staged");
          return [{ id: 1 }];
        },
      }),
    }),
  };
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      trace.push("begin");
      const result = await fn(tx);
      ready();
      await commitFence;
      deleted = stagedDelete;
      trace.push("commit");
      return result;
    },
  } as unknown as Db;
  const queueSend = vi.fn(async (_message: unknown) => {
    trace.push(deleted ? "dispatch" : "dispatch-before-commit");
  });
  const env = { ...baseEnv, ADMIN_DB: db, SYNC_EVENT_QUEUE: { send: queueSend } };
  return { env, trace, queueSend, readyToCommit, release, deleted: () => deleted };
}

describe("registered DELETE RSVP commit and dispatch", () => {
  it("commits the caller withdrawal before dispatch and answers an empty 204 even for HTML", async () => {
    const fixture = withdrawalFixture();
    let settled = false;
    const pending = Promise.resolve(
      app.request(
        `/events/${KEY}/rsvp`,
        {
          method: "DELETE",
          headers: { accept: "text/html" },
        },
        fixture.env,
      ),
    ).then((response) => {
      settled = true;
      return response;
    });
    try {
      await fixture.readyToCommit;
      expect(fixture.deleted()).toBe(false);
      expect(fixture.queueSend).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      fixture.release();
    }
    const res = await pending;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(fixture.deleted()).toBe(true);
    expect(fixture.queueSend).toHaveBeenCalledOnce();
    expect(fixture.queueSend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "sync-event", eventKey: KEY }),
      { delaySeconds: 10 },
    );
    expect(fixture.trace).toEqual(["begin", "delete-staged", "commit", "dispatch"]);
  });

  it.each([
    [{ exists: false }, 404, "not_found"],
    [{ limited: true }, 429, "rate_limited"],
  ] as const)("refused withdrawal %j never dispatches", async (options, status, code) => {
    const fixture = withdrawalFixture(options);
    fixture.release();
    const res = await app.request(
      `/events/${KEY}/rsvp`,
      {
        method: "DELETE",
        headers: { accept: "application/json" },
      },
      fixture.env,
    );
    expect(res.status).toBe(status);
    const body = await res.json();
    if (status === 404) expect(body).toEqual({ error: code });
    else {
      expect(body).toMatchObject({ reason: code, retry_after: 7 });
      expect(res.headers.get("retry-after")).toBe("7");
    }
    expect(fixture.deleted()).toBe(false);
    expect(fixture.queueSend).not.toHaveBeenCalled();
    expect(fixture.trace).toEqual(["begin", "commit"]);
  });
});
