import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { fetchKitEventWrite, refuseKitEventWriteOrigin } from "../src/events/kit-event-write-fetch";
import { KIT_EVENT_WRITE_ROUTES } from "../src/events/kit-event-write-routes";
import { registerRsvpRoutes } from "../src/events/routes-rsvp";
import type { QueueMessage } from "../src/jobs/types";
import { dispatchHookRequest, type HookEventLike } from "../src/route-ownership";
import { sameOrigin } from "../src/same-origin";
import { fakeRsvpDb } from "./helpers/fake-rsvp-db";

vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));

const APP_URL = "https://fixture.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JSON_RSVP = `/events/${KEY}/rsvp`;
const FORM_RSVP = `/e/${KEY}/rsvp`;
const MEMBER: Session = {
  id: "420000000000000042",
  username: "fixture-member",
  avatar: null,
  member: true,
  moderator: false,
};

function fixture(flag: string | null = "true") {
  const transaction = vi.fn<Db["transaction"]>(() => {
    throw new Error("unexpected transaction");
  });
  const queueSend = vi.fn(async (_message: unknown) => {});
  const session = vi.fn(async () => MEMBER);
  const moderatorThrottle = vi.fn(async () => null);
  const env = {
    APP_URL,
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    ADMIN_DB: { transaction },
    SYNC_EVENT_QUEUE: { send: queueSend },
    THROTTLE_STORE: moderatorThrottle,
  } as unknown as Env;
  const hono = new Hono<{ Bindings: Env }>();
  hono.use("*", sameOrigin);
  registerRsvpRoutes(hono, session);
  const honoFetch = vi.fn(async (request: Request) => hono.fetch(request, env));
  const resolve = vi.fn((event: HookEventLike) => {
    const locals = event.locals as { requestId?: string };
    return fetchKitEventWrite(event.request, env, locals.requestId, session);
  });
  const readKitPageSession = vi.fn(async () => {
    throw new Error("write unexpectedly invoked the page session bridge");
  });
  return {
    transaction,
    queueSend,
    session,
    moderatorThrottle,
    honoFetch,
    resolve,
    readKitPageSession,
    request(request: Request, id: string) {
      return dispatchHookRequest(
        { request, url: new URL(request.url), route: { id } },
        {
          appUrl: APP_URL,
          honoFetch,
          resolve,
          sessionFor: readKitPageSession,
          apiFamilies: [
            {
              flag: flag ?? undefined,
              routes: KIT_EVENT_WRITE_ROUTES,
              crossOriginRefusal: (request, requestId) =>
                refuseKitEventWriteOrigin(request, env, requestId),
            },
          ],
        },
      );
    },
  };
}

function form(path: string, method: string, body: string, headers?: HeadersInit) {
  const input = new Headers(headers);
  if (!input.has("origin")) input.set("origin", APP_URL);
  input.set("content-type", "application/x-www-form-urlencoded");
  return new Request(new URL(path, APP_URL), { method, headers: input, body });
}

describe("Kit event-write admission", () => {
  it.each([null, "", "false", "TRUE"])(
    "hands the unread write to Hono for flag %j",
    async (flag) => {
      const f = fixture(flag);
      f.session.mockResolvedValueOnce({ ...MEMBER, member: false });
      const request = form(JSON_RSVP, "PUT", "status=going");
      const response = await f.request(request, "/events/[key]/rsvp");
      expect(response.status).toBe(403);
      expect(response.headers.get("x-two-renderer")).toBeNull();
      expect(f.honoFetch).toHaveBeenCalledExactlyOnceWith(request);
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.readKitPageSession).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PROPFIND"])(
    "%s keeps the fixed RSVP Allow and Accept contract",
    async (method) => {
      const f = fixture();
      for (const accept of ["application/json", "text/html"]) {
        const response = await f.request(
          new Request(new URL(JSON_RSVP, APP_URL), {
            method,
            headers: { origin: APP_URL, accept },
          }),
          "/events/[key]/rsvp",
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("x-two-renderer")).toBe("kit");
        expect(response.headers.get("allow")).toBe("PUT, DELETE");
        expect(response.headers.get("vary")).toBe("Accept");
        if (accept === "application/json" && method !== "HEAD") {
          expect(await response.json()).toEqual({
            error: "method_not_allowed",
            request_id: response.headers.get("x-request-id"),
          });
        } else {
          expect(await response.text()).toBe("");
        }
      }
      expect(f.session).not.toHaveBeenCalled();
      expect(f.transaction).not.toHaveBeenCalled();
      expect(f.honoFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["PUT", JSON_RSVP, "/events/[key]/rsvp", BODY_LIMIT_BYTES.action],
    ["DELETE", JSON_RSVP, "/events/[key]/rsvp", BODY_LIMIT_BYTES.action],
    ["POST", FORM_RSVP, "/e/[key]/rsvp", BODY_LIMIT_BYTES.action],
    ["POST", "/events", "/events", BODY_LIMIT_BYTES.json],
    ["PATCH", `/events/${KEY}`, "/events/[key]", BODY_LIMIT_BYTES.json],
    ...["publish", "cancel", "duplicate", "rsvp-pause", "rsvp-reopen"].map(
      (action) =>
        [
          "POST",
          `/events/${KEY}/${action}`,
          "/events/[key]/[action]",
          BODY_LIMIT_BYTES.action,
        ] as const,
    ),
  ] as const)(
    "%s %s refuses streamed overflow before throttle or session",
    async (method, path, id, cap) => {
      const f = fixture();
      const response = await f.request(
        form(path, method, "x".repeat(cap + 1), {
          "content-length": "1",
          accept: "application/json",
        }),
        id,
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("x-two-renderer")).toBe("kit");
      expect(await response.json()).toMatchObject({ reason: "payload_too_large" });
      expect(f.moderatorThrottle).not.toHaveBeenCalled();
      expect(f.session).not.toHaveBeenCalled();
      expect(f.readKitPageSession).not.toHaveBeenCalled();
      expect(f.transaction).not.toHaveBeenCalled();
      expect(f.queueSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    [FORM_RSVP, "/e/[key]/rsvp", "text/html"],
    [JSON_RSVP, "/events/[key]/rsvp", "application/json"],
  ] as const)("rejects foreign Origin as %s before reading the body", async (path, id, media) => {
    const f = fixture();
    const request = form(path, path === FORM_RSVP ? "POST" : "PUT", "status=going", {
      origin: "https://other.example.test",
      "sec-fetch-site": "same-origin",
      accept: "text/html",
    });
    const response = await f.request(request, id);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(media);
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("x-two-renderer")).toBe("kit");
    expect(request.bodyUsed).toBe(false);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.honoFetch).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("matches the Hono no-JS refusal at the cap without entering the transaction", async () => {
    const f = fixture();
    const body = "status=going&attendees=2&padding=".padEnd(BODY_LIMIT_BYTES.action, "x");
    const path = `${FORM_RSVP}?attendees=2`;
    f.session.mockResolvedValue({ ...MEMBER, member: false });
    const request = () => form(path, "POST", body, { accept: "text/html" });
    const kit = await f.request(request(), "/e/[key]/rsvp");
    const hono = await f.honoFetch(request());
    expect(kit.status).toBe(403);
    expect(kit.headers.get("content-type")).toContain("text/html");
    const html = await kit.text();
    expect(html).toContain(`href="/e/${KEY}?attendees=2"`);
    expect(html).toBe(await hono.text());
    expect(f.session).toHaveBeenCalledTimes(2);
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.queueSend).not.toHaveBeenCalled();
  });

  it("binds rank to the caller and event and waits for commit before dispatch", async () => {
    const f = fixture();
    let markAtCommit!: () => void;
    let releaseCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      markAtCommit = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const eventId = 42;
    const handle = fakeRsvpDb({
      event: {
        id: eventId,
        eventKey: KEY,
        status: "published",
        rsvpOpen: true,
        startsAt: new Date("2099-01-01T01:00Z"),
        endsAt: new Date("2099-01-01T02:00Z"),
        capacity: 1,
        discordEventId: "fixture-mirror",
      },
      existing: null,
      throttleCount: { n: 0, wait: 0 },
      goingCount: 1,
      rejectPromotionLookup: true,
      waitlistRank: { event_id: eventId, user_id: MEMBER.id, position: 2 },
      finalRow: () => ({ ...handle.inserted[0], syncedToDiscordAt: null }),
    });
    const trace: string[] = [];
    f.transaction.mockImplementation(async (run) => {
      const result = await handle.db.transaction(run);
      markAtCommit();
      await commit;
      trace.push("commit");
      return result;
    });
    f.queueSend.mockImplementation(async () => {
      trace.push("dispatch");
    });
    const response = f.request(form(JSON_RSVP, "PUT", "status=going"), "/events/[key]/rsvp");
    try {
      await Promise.race([
        atCommit,
        response.then((r) => {
          throw new Error(`RSVP answered ${r.status} before commit`);
        }),
      ]);
      expect(handle.inserted).toMatchObject([{ eventId, userId: MEMBER.id, status: "waitlisted" }]);
      expect(f.queueSend).not.toHaveBeenCalled();
    } finally {
      releaseCommit();
    }
    const result = await response;
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({
      data: { status: "waitlisted", waitlist_position: 2, synced_to_discord_at: null },
    });
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.queueSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "sync-event", eventKey: KEY }),
      { delaySeconds: 10 },
    );
    expect(trace).toEqual(["commit", "dispatch"]);
  });
});
