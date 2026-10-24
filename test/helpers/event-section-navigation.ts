// Fixture-only renderer seam for the event-section acceptance pair.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../../src/events/kit-detail";
import type { KitRequestSession } from "../../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";
import { scheduleCases } from "../fixtures/event-scheduled-range";
import { scheduledEvent, type KitRenderer, type Twin } from "./event-scheduled-range";

export { compileScheduleKit, type KitRenderer, type Twin } from "./event-scheduled-range";
export const sectionOrigin = "https://sections.example.test";
export const sectionPath = "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
export type SectionViewer = "guest" | "outsider" | "member" | "moderator";
export const sectionAttendees = [
  { id: "100000000000000031", name: "section-private-one" },
  { id: "100000000000000032", name: "section-private-two" },
];
type EventRow = typeof events.$inferSelect;

export function sectionEvent(over: Partial<EventRow> = {}): EventRow {
  return scheduledEvent(scheduleCases[0], {
    startsAt: new Date("2030-01-10T20:00:00Z"),
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    description: "Bring a board and meet other players. ".repeat(75),
    accessibilityNotes: "Step-free entry. Quiet room available. Captions supported.",
    join_url: "https://join.example.test/community-room",
    join_instructions: "Find the community room, choose a table, and ask the host. ".repeat(70),
    ...over,
  });
}

export async function renderSectionPage(
  twin: Twin,
  row: EventRow,
  viewer: SectionViewer,
  kit: KitRenderer,
) {
  const reads: string[] = [];
  let rosterReads = 0;
  const originalDate = globalThis.Date;
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2029-01-01T12:00:00Z");
  let fetches = 0;
  globalThis.Date = new Proxy(originalDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [now]);
    },
    get(target, key) {
      return key === "now" ? () => now : Reflect.get(target, key);
    },
  });
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Section fixtures forbid network access");
  };
  const render = async () => {
    if (twin === "Hono") {
      const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
      const db = drizzle(async (sql) => {
        if (/^\s*select\b/i.test(sql) && /\bfrom\b/i.test(sql)) reads.push(sql);
        if (sql.includes('join "users"') && !sql.includes("count(*)")) {
          rosterReads += 1;
          return { rows: sectionAttendees.map(({ id, name }) => [id, name]) };
        }
        if (sql.includes('from "rsvps"')) {
          return sql.includes("count(*)") ? { rows: [[row.id, 2]] } : { rows: [] };
        }
        if (sql.includes('"event_key" =')) {
          return {
            rows: [
              columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
            ],
          };
        }
        return { rows: [] };
      });
      // Shim the session, which the real member-read observer clones. The
      // audit recorder still runs; no persistence/transaction claim is made.
      const proxySession = (
        db as unknown as {
          session: { transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> };
        }
      ).session;
      proxySession.transaction = async (fn) => fn(db as unknown as Db);
      const sessions = createMemorySessionStore();
      const secret = "test-session-secret-at-least-32-bytes-long";
      const env = {
        APP_URL: sectionOrigin,
        SESSION_SECRET: secret,
        SESSION_STORE: sessions,
        ADMIN_DB: db as unknown as Db,
      } as unknown as Env;
      const headers: Record<string, string> = {};
      if (viewer !== "guest") {
        const token = newSessionToken();
        await sessions.create({
          tokenHash: await hashToken(token),
          userId: "100000000000000001",
          username: "fixture-viewer",
          avatar: null,
          member: viewer !== "outsider",
          moderator: viewer === "moderator",
          expiresAt: new Date(now + 3600_000),
        });
        headers.cookie = (
          await serializeSigned("__Host-two_session", token, secret, {
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          })
        ).split(";")[0]!;
      }
      const response = await app.request(sectionPath, { headers }, env);
      return {
        status: response.status,
        html: await response.text(),
        headers: Object.fromEntries(response.headers),
        reads,
        rosterReads,
      };
    }
    const session: KitRequestSession =
      viewer === "guest"
        ? { status: "guest", session: null }
        : {
            status: "authenticated",
            session: {
              userId: "100000000000000001",
              username: "fixture-viewer",
              avatar: null,
              member: viewer !== "outsider",
              moderator: viewer === "moderator",
            },
          };
    const store: KitEventDetailStore = {
      dbForFn: async () => ({}) as Db,
      getEventFn: async () => {
        reads.push("event");
        return { ...row, goingCount: 2, goingOccupancy: 2 };
      },
      neighborsFn: async () => {
        reads.push("neighbors");
        return { previous: null, next: null };
      },
      relatedFn: async () => {
        reads.push("related");
        return [];
      },
      seriesFn: async () => {
        reads.push("series");
        return null;
      },
      attendeesFn: async () => {
        reads.push("attendees");
        rosterReads += 1;
        return sectionAttendees;
      },
      viewerRsvpFn: async () => {
        reads.push("rsvp");
        return null;
      },
      waitlistFn: async () => {
        reads.push("waitlist");
        return null;
      },
      suggestionsFn: async () => {
        reads.push("suggestions");
        return [];
      },
    };
    const headers: Record<string, string> = {};
    const outcome = await resolveKitEventDetail({
      key: row.eventKey,
      search: "",
      path: sectionPath,
      env: { APP_URL: sectionOrigin } as Env,
      session,
      joinResult: null,
      setHeaders: (values) => Object.assign(headers, values),
      store,
    });
    if (outcome.kind === "forbidden") {
      return { status: outcome.status, html: "", headers, reads, rosterReads };
    }
    if (outcome.kind !== "ok" && outcome.kind !== "gone") {
      throw new Error(`Unexpected section fixture outcome: ${outcome.kind}`);
    }
    const { head, body } = (outcome.kind === "ok" ? kit.detail : kit.gone)(
      outcome.model as unknown as Record<string, unknown>,
    );
    return {
      status: outcome.kind === "ok" ? 200 : outcome.status,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`,
      headers,
      reads,
      rosterReads,
    };
  };
  try {
    const result = await render();
    if (fetches) throw new Error(`Fixture attempted ${fetches} external fetches`);
    return result;
  } finally {
    globalThis.Date = originalDate;
    globalThis.fetch = originalFetch;
  }
}
