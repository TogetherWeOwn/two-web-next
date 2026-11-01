import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import type { Db } from "../../src/db";
import { events } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import { kitEventDetailStore, resolveKitEventDetail } from "../../src/events/kit-detail";
import type { PublicEvent } from "../../src/events/reads";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";
import { ORIGIN } from "../fixtures/schedule-availability";
import { at } from "./event-ongoing-acceptance";
import type { KitRenderer, Twin } from "./event-scheduled-range";

// Real routes, read functions, aggregates and SSR; only SQL results and the
// member session are fixtures. The transcript catches added detail queries.
export async function detailSnapshot(twin: Twin, row: PublicEvent, kit: KitRenderer, now: Date) {
  return at(now, async () => {
    const queries: string[] = [];
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    const db = drizzle(async (sql) => {
      queries.push(sql.trim());
      if (!/^\s*select\b/i.test(sql)) throw new Error(`Unexpected write: ${sql}`);
      if (sql.includes("from rsvps")) return { rows: [] };
      if (sql.includes('from "rsvps"')) {
        if (sql.includes("count(*)")) {
          return {
            rows: [[row.id, sql.includes('join "users"') ? row.goingCount : row.goingOccupancy]],
          };
        }
        return { rows: [] };
      }
      if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
        return {
          rows: [
            columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
          ],
        };
      }
      if (sql.includes('from "events"')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as Db;
    const secret = "test-session-secret-at-least-32-bytes-long";
    const sessions = createMemorySessionStore();
    const env = {
      APP_URL: ORIGIN,
      ADMIN_DB: db,
      SESSION_SECRET: secret,
      SESSION_STORE: sessions,
    } as unknown as Env;
    const session = {
      userId: "100000000000000001",
      username: "fixture-member",
      avatar: null,
      member: true,
      moderator: true,
    };
    const path = `/e/${row.eventKey}`;
    if (twin === "Hono") {
      const token = newSessionToken();
      await sessions.create({
        ...session,
        tokenHash: await hashToken(token),
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
      const cookie = (
        await serializeSigned("__Host-two_session", token, secret, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      const response = await app.request(path, { headers: { cookie } }, env);
      return {
        status: response.status,
        html: await response.text(),
        headers: response.headers,
        queries,
      };
    }
    const outcome = await resolveKitEventDetail({
      key: row.eventKey,
      path,
      search: "",
      env,
      session: { status: "authenticated", session },
      joinResult: null,
      setHeaders: () => {},
      store: kitEventDetailStore(env),
    });
    if (outcome.kind !== "ok" && outcome.kind !== "gone")
      throw new Error(`Unexpected ${outcome.kind} outcome`);
    const rendered = (outcome.kind === "ok" ? kit.detail : kit.gone)(
      outcome.model as unknown as Record<string, unknown>,
    );
    return {
      status: outcome.status,
      html: rendered.head + rendered.body,
      headers: new Headers(outcome.headers),
      queries,
    };
  });
}
