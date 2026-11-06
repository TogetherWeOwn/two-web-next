// Local capture prerequisite, not an e2e runner or a deployed authentication seam.
import assert from "node:assert/strict";
import postgres from "postgres";
import { serializeSigned } from "hono/utils/cookie";
import { SESSION_COOKIE } from "../../src/session-cookie";
import {
  createPostgresSessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
  type Sql,
} from "../../src/sessions";
import { loadJoinsGrid, priorGrid } from "../../src/hotzones/aggregates";
import { loadMemberRanking } from "../../src/leaderboards/members";
import { createMemberDataFixture, testDatabaseUrl } from "./member-data-db";
import {
  CAPTURE_IDENTITIES,
  CAPTURE_SEED,
  assertCaptureData,
  captureHash,
  captureManifest,
  captureTables,
  type CapturePersona,
  type CaptureTables,
} from "./ember-capture-data";

export function requireCaptureTarget(
  input: { seedId?: string; databaseUrl?: string; appUrl?: string },
  runner = process.env,
) {
  if (input.seedId !== CAPTURE_SEED)
    throw new Error("Capture requires explicit ember-capture-v1 opt-in");
  let app: URL;
  try {
    app = new URL(input.appUrl ?? "");
  } catch {
    throw new Error("Capture requires an http loopback APP_URL");
  }
  if (
    app.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(app.hostname) ||
    app.username ||
    app.password ||
    app.search ||
    app.hash ||
    app.pathname !== "/"
  )
    throw new Error("Capture requires an http loopback APP_URL");
  // Reuse without widening either the local fixture validator or the legacy e2e guard.
  const url = testDatabaseUrl(input.databaseUrl ?? "", runner);
  // A killed process cannot drop its schema; the caller must own the whole DB/container.
  if (url.hostname === "agent-testdb" && !/^\/two_web_next_tog[0-9]+$/.test(url.pathname))
    throw new Error("Capture requires a fresh run-owned disposable test database");
  return url;
}

export async function mintCaptureSession(
  store: SessionStore,
  persona: CapturePersona,
  secret: string,
  now = Date.now(),
) {
  if (persona === "guest") return null;
  if (persona !== "member" && persona !== "moderator") throw new Error("Unknown capture persona");
  if (typeof secret !== "string" || secret.length < 32 || !Number.isFinite(now))
    throw new Error("Invalid local session setup");
  const actor = CAPTURE_IDENTITIES[persona];
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    ...actor,
    avatar: null,
    expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000),
  });
  // Private in-memory handoff only. Never put this value in a manifest or report.
  return (
    await serializeSigned(SESSION_COOKIE, token, secret, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
    })
  ).split(";")[0]!;
}

export async function createEmberCapture(input: {
  seedId: string;
  databaseUrl: string;
  appUrl: string;
}) {
  const url = requireCaptureTarget(input); // Before any pool, migration or connection.
  const fixture = await createMemberDataFixture(url.href);
  // Keep session-driver serializers separate from Drizzle's timestamp serializers.
  const sessionClient = postgres(url.href, {
    max: 1,
    port: 5432,
    password: () => url.password,
    connect_timeout: 5,
    connection: { search_path: fixture.schemaName, statement_timeout: 5000, lock_timeout: 1000 },
    onnotice: () => {},
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await sessionClient.end({ timeout: 1 });
    } finally {
      await fixture.dispose();
    }
  };
  const ensureOpen = () => {
    if (disposed) throw new Error("Capture fixture is disposed");
  };
  const snapshot = async (): Promise<CaptureTables> => {
    ensureOpen();
    const result: CaptureTables = {};
    for (const [table, rows] of Object.entries(captureTables())) {
      const columns = Object.keys(rows[0]!);
      const selected =
        await fixture.client`select ${fixture.client(columns)} from ${fixture.client(table)} order by ${fixture.client(columns[0]!)}`;
      result[table] = selected.map((row) =>
        Object.fromEntries(
          columns.map((column) => {
            const value = row[column];
            return [
              column,
              column.endsWith("_at") && value !== null
                ? new Date(value).toISOString()
                : typeof rows[0]![column] === "number"
                  ? Number(value)
                  : value,
            ];
          }),
        ),
      );
    }
    return result;
  };
  const verify = async () => {
    const actual = await snapshot();
    assertCaptureData(actual);
    const manifest = captureManifest();
    const all = { kind: "all", label: "All time" } as const;
    const joins = await loadJoinsGrid(fixture.db, all);
    assert.equal(joins.total, manifest.aggregates.joins.successfulAttempts);
    assert.equal(joins.eventCount, manifest.aggregates.joins.allTimeEventCount);
    const leaderboard = await loadMemberRanking(fixture.db, all, null);
    assert.deepEqual(
      leaderboard.map(({ userId, count }) => ({ userId, count })),
      manifest.aggregates.leaderboard.allTime,
    );
    assert.equal(
      captureHash({
        tables: actual,
        voice: priorGrid("voice"),
        games: priorGrid("games"),
      }),
      manifest.dataHash,
    );
    return manifest;
  };
  const resetAndSeed = async () => {
    ensureOpen();
    // This fixture owns its schema. Never truncate, migrate or write caller/public/bot tables.
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
    await fixture.client`delete from featured_contents`;
    await fixture.client`delete from board_view_logs`;
    await fixture.reset();
    await fixture.client.begin(async (tx) => {
      for (const [table, rows] of Object.entries(captureTables())) {
        const columns = Object.keys(rows[0]!);
        const quoted = (s: string) => `"${s}"`; // Only the closed, source-owned table/column registry.
        const statement = `insert into ${quoted(table)} (${columns.map(quoted).join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`;
        for (const row of rows) {
          const values = columns.map((key) => {
            const value = row[key]!;
            return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
          });
          await tx.unsafe(statement, values);
        }
        // Explicit stable IDs must not collide with a later local insert.
        if (typeof rows[0]!.id === "number")
          await tx`select setval(pg_get_serial_sequence(${table}, 'id'), ${Math.max(...rows.map((r) => Number(r.id)))}, true)`;
      }
    });
    return verify();
  };
  try {
    const manifest = await resetAndSeed();
    return {
      manifest,
      db: fixture.db,
      client: fixture.client,
      schemaName: fixture.schemaName,
      snapshot,
      verify,
      resetAndSeed,
      dispose,
      session: (persona: CapturePersona, secret: string) => {
        ensureOpen();
        return mintCaptureSession(
          createPostgresSessionStore(sessionClient as unknown as Sql),
          persona,
          secret,
        );
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
