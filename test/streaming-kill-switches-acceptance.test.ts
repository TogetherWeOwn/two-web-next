// route-inventory: GET /admin/streaming
// route-inventory: POST /admin/streaming/disable
// route-inventory: POST /admin/streaming/enable
// route-inventory: POST /admin/streaming/global/disable
// route-inventory: POST /admin/streaming/global/enable
// route-inventory: POST /admin/streaming/global/notify
// route-inventory: POST /streaming/setup/disable
// route-inventory: GET /streaming/reports/new
// route-inventory: POST /streaming/reports
// Acceptance: streaming kill switches (K1 per-member, K2 global) + moderator
// admin page + merged runbooks (design spec section 9, slice S7).
//
// S7 is the last streaming slice: the member self-disable button, the moderator
// per-member kill, the global kill, the abuse-report intake, the strike copy,
// and docs/streaming-runbooks.md merging the K1/K2/key-compromise procedures
// with a recorded staging drill. Strike enforcement (7-day suspension, second
// cancel plus pro-rata refund with a 90-day re-subscribe block) ships as copy
// only: the owner/legal Terms update is flagged in the runbook, not blocking.
//
// Locked contract (the paired Builder satisfies this without editing this file):
// - Transport: every Cloudflare Stream call goes through global fetch (the
//   Workers runtime boundary). Wrapping fetch in a small client module is
//   fine, but the HTTP calls stay observable on global fetch: the tests stub
//   fetch as the fake Stream server. Endpoint shapes follow the spec runbook:
//   POST .../live_inputs/:uid/disable, POST .../live_inputs/:uid/enable,
//   PUT .../outputs/:uid with a JSON enabled boolean, GET .../live_inputs/:uid
//   for status. Host and account path segments are the Builder's choice (tests
//   match substrings). Every Stream call carries an authorization or x-auth-key
//   header; bindings set STREAM_API_TOKEN for it. The fake status body carries
//   result.status ("connected"/"disconnected") and result.live (boolean).
// - Admin page: GET /admin/streaming is moderator-gated (guest GET 302
//   /auth/discord; guest POST 303 /auth/recover?next=%2Fadmin%2Fstreaming;
//   signed non-moderator 403 on all six) with private, no-store. It renders
//   native POST forms (phone-usable, no-JS): k1-disable-form (user_id,
//   reason), k1-enable-form (user_id), k2-disable-form (reason),
//   k2-enable-form, k2-notify-form, plus global-status, k2-mass-results,
//   k2-verify-samples, streaming-reports (always rendered, explicit empty
//   state) and strike-policy (7-day, 90-day, pro-rata copy) testids.
// - K1 kill: POST /admin/streaming/disable {user_id, reason} answers 200 with
//   "Streaming disabled for @user at HH:MM UTC". In order: Cloudflare input
//   disable, each output PUT enabled=false, stream_live_inputs.enabled=false,
//   open ingest_sessions row closed (ended_reason exactly kill_switch),
//   activity_log row (log_name streaming, causer the moderator, subject_type
//   stream_live_input, subject_id the affected user id, properties carrying
//   the input uid and reason). Reason is required (blank is 422 HTML with
//   role=alert, nothing changes). A stream_notifications kill_notice row
//   (reason, non-empty appeal_path) records the member notice; the setup page
//   shows streaming-kill-notice with reason, appeal path and strike copy.
//   Unknown users (no input row) are 404. A Cloudflare failure answers 502
//   with the database untouched (no partial kill); a failed output names the
//   output and skips its siblings for that input only.
// - Member self-disable: POST /streaming/setup/disable applies the same K1
//   effects to the caller's own input (reason optional), then 303s to
//   /streaming/setup. Guest 303 /auth/recover?next=%2Fstreaming%2Fsetup,
//   signed non-member 403, non-subscriber 404. Owner-only by construction.
// - Re-enable: POST /admin/streaming/enable {user_id} is moderator-only,
//   reverses the kill (Cloudflare enable, outputs on, enabled=true) and sets
//   must_rotate_key=true; the setup page shows streaming-rotate-required.
//   Enabling an already-enabled input is a 200 no-op that leaves the flag
//   false. Rotation itself belongs to the setup slice; the flag column
//   (boolean, default false, added by an S7 ALTER TABLE) is this slice.
// - K2 global: STREAMING_GLOBAL_ENABLED=false (or "0"; anything else,
//   including unset, means enabled) takes effect on reads immediately:
//   setup writes 503 with a plain message, live pages render a maintenance
//   note, setup/live pages carry streaming-outage-banner. POST
//   /admin/streaming/global/disable {reason} persists stream_settings
//   key=global {enabled, disabledAt, disabledReason}, mass-disables every
//   input through the fake with per-input success/failure listed, closes open
//   sessions as kill_switch, audits once (subject_id global, properties with
//   reason and per-input outcomes) and writes no kill_notice rows (outage
//   comms go through the notify path). POST /admin/streaming/global/notify
//   queues one stream_notifications outage_email row per active subscriber
//   (status exactly active; canceled, paused, past_due and never-subscribed
//   excluded) and audits. POST /admin/streaming/global/enable re-enables
//   active-only inputs (each with must_rotate_key=true), lists skipped rows,
//   performs status reads and renders k2-verify-samples. The outage banner
//   takes precedence over the kill notice on member pages.
// - Reports: GET /streaming/reports/new renders stream-report-form (member
//   gate, ?user= prefill); POST /streaming/reports {reported_user_id,
//   session_id?, reason} requires reason (422 + preserved draft otherwise),
//   404s unknown users, 303s to the reported member's live page and stores a
//   stream_reports row (reporter, reported, session, reason, status open)
//   visible with full stream context in streaming-reports. Report links on
//   the live and links pages are origin-relative, resolve (never 404), and at
//   least one per page targets the intake form. Writes are throttled at the
//   repo-standard member-write budget (429 proof on the intake; the
//   every-POST-throttled audit enforces middleware presence on all seven
//   POST routes).
// - Docs: docs/streaming-runbooks.md merges K1, K2 and key-compromise as
//   operable steps, carries the strike policy, flags the owner/legal Terms
//   update, and records a completed staging drill (date, K1+K2 scope,
//   result). No secrets, no tracker ids. The moderator admin guide lists the
//   new admin routes.
// - Schema (S7-owned): stream_reports, stream_notifications, stream_settings
//   (key TEXT PK, value JSONB) via journaled migrations. S7 never creates
//   subscriptions, stream_live_inputs, stream_destinations, ingest_sessions
//   or member_links: those belong to earlier slices and this card's branch
//   must stack on them. Reads through the injected admin Db need
//   classification (or a queue-preview-style raw client); unclassified
//   statements refuse.
// - Recovery bounces: guest POSTs map onto their GET form pages (admin
//   /streaming/* onto /admin/streaming via the admin return map, member
//   routes onto /streaming/setup and /streaming/reports/new). a11y coverage
//   lists /admin/streaming and /streaming/reports/new with real cases.
// - Explicitly unpinned: reconciler internals and minute math (metering
//   slice), key rotation mechanics (setup slice clears the flag), live-state
//   cache timing (live-page slice), throttle bucket names, notification
//   delivery (outbox rows only; live sending is an operator launch step),
//   report triage beyond listing, exact 422/502 page styling, response
//   caching, and the drill transcript beyond its record.
//
// Hermetic sections (routes, gates, a11y table, docs, migration files) run
// everywhere. Behavior sections need DATABASE_URL (disposable test database;
// skipped otherwise) and stub only global fetch.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeAll, afterEach, afterAll } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import rawApp from "../src/index";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE } from "../src/throttle";
import testApp from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { cookieFor, env } from "./helpers/member-data";
import { routeInventory } from "./helpers/route-inventory";
// @ts-expect-error Standalone probe tooling has no declaration file.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { coverage } from "../ci/a11y-cases.mjs";
// @ts-expect-error Standalone probe tooling has no declaration file.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { auditCases } from "../ci/a11y-policy.mjs";

type Client = MemberDataFixture["client"];

type Actor = { userId: string; username: string; member: boolean; moderator: boolean };

const MODERATOR: Actor = {
  userId: "100000000000000103",
  username: "w15-moderator",
  member: true,
  moderator: true,
};
const OUTSIDER: Actor = {
  userId: "100000000000000104",
  username: "w15-outsider",
  member: false,
  moderator: false,
};

let idSeq = 200;
const freshId = (): string => `10000000000000${++idSeq}`;
const memberActor = (username: string): Actor => ({
  userId: freshId(),
  username,
  member: true,
  moderator: false,
});

let ipSeq = 0;
const freshIp = (): string => `203.0.113.${(ipSeq++ % 240) + 1}`;

const STREAM_ROUTES = [
  "GET /admin/streaming",
  "POST /admin/streaming/disable",
  "POST /admin/streaming/enable",
  "POST /admin/streaming/global/disable",
  "POST /admin/streaming/global/enable",
  "POST /admin/streaming/global/notify",
  "POST /streaming/setup/disable",
  "GET /streaming/reports/new",
  "POST /streaming/reports",
] as const;

const ADMIN_ROUTES = STREAM_ROUTES.filter((r) => r.includes("/admin/"));

async function tableExists(client: Client, table: string): Promise<boolean> {
  const rows = (await client`SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ${table}
  ) AS exists`) as unknown as { exists: boolean }[];
  return rows[0]?.exists === true;
}

async function requireTables(
  client: Client,
  tables: { name: string; owner: string }[],
): Promise<void> {
  for (const t of tables) {
    const ok = await tableExists(client, t.name);
    expect(
      ok,
      `BUILDER: table ${t.name} missing; land the ${t.owner} migration (design spec section 4, S7 header)`,
    ).toBe(true);
  }
}

async function requireColumns(
  client: Client,
  table: string,
  cols: string[],
  owner: string,
): Promise<void> {
  const rows = (await client`SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}`) as unknown as {
    column_name: string;
  }[];
  const have = new Set(rows.map((r) => r.column_name));
  for (const c of cols) {
    expect(
      have.has(c),
      `BUILDER: ${table} lacks column ${c}; ${owner} owns this shape (spec section 4, S7 header)`,
    ).toBe(true);
  }
}

const S2 = "subscriptions slice (S2)";
const S3 = "live-input setup slice (S3)";
const S4 = "destinations slice (S4)";
const S6 = "quotas and ledger slice (S6)";
const S7 = "this kill-switch slice (S7)";

async function seedUsers(client: Client, actors: Actor[]): Promise<void> {
  for (const a of actors) {
    await client`INSERT INTO users (id, username, member) VALUES (${a.userId}, ${a.username}, ${a.member})
      ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, member = EXCLUDED.member`;
  }
}

async function seedProfile(client: Client, userId: string): Promise<void> {
  // games stays on its '[]' default; no suite reads it.
  await client`INSERT INTO profiles (user_id, bio) VALUES (${userId}, ${"Streamer bio"})
    ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio`;
}

async function seedSubscription(
  client: Client,
  userId: string,
  tier = "basic",
  status = "active",
): Promise<void> {
  await requireTables(client, [{ name: "subscriptions", owner: S2 }]);
  await requireColumns(
    client,
    "subscriptions",
    [
      "user_id",
      "stripe_customer_id",
      "stripe_subscription_id",
      "tier",
      "status",
      "current_period_start",
      "current_period_end",
      "cancel_at_period_end",
    ],
    S2,
  );
  const start = new Date(Date.now() - 86400000);
  const end = new Date(Date.now() + 30 * 86400000);
  await client`INSERT INTO subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, tier, status,
      current_period_start, current_period_end, cancel_at_period_end
    ) VALUES (
      ${userId}, ${`cus_test_${userId}`}, ${`sub_test_${userId}`}, ${tier}, ${status},
      ${start}, ${end}, ${false}
    )
    ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, status = EXCLUDED.status,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end`;
}

async function seedInput(
  client: Client,
  userId: string,
  uid: string,
  enabled = true,
): Promise<void> {
  await requireTables(client, [{ name: "stream_live_inputs", owner: S3 }]);
  await requireColumns(
    client,
    "stream_live_inputs",
    ["user_id", "cf_input_uid", "ingest_key_enc", "ingest_key_iv", "enabled", "recording_mode"],
    S3,
  );
  await client`INSERT INTO stream_live_inputs
      (user_id, cf_input_uid, ingest_key_enc, ingest_key_iv, enabled, recording_mode)
    VALUES (${userId}, ${uid}, ${Buffer.from(`ct-${uid}`)}, ${Buffer.from(`iv-${uid.slice(0, 8)}`)}, ${enabled}, ${"off"})
    ON CONFLICT (user_id) DO UPDATE SET cf_input_uid = EXCLUDED.cf_input_uid, enabled = EXCLUDED.enabled`;
}

async function seedOutput(
  client: Client,
  userId: string,
  label: string,
  cfUid: string,
  enabled = true,
): Promise<void> {
  await requireTables(client, [{ name: "stream_destinations", owner: S4 }]);
  await requireColumns(
    client,
    "stream_destinations",
    ["user_id", "cf_output_uid", "provider", "label", "url_enc", "key_enc", "iv", "enabled"],
    S4,
  );
  await client`INSERT INTO stream_destinations
      (user_id, cf_output_uid, provider, label, url_enc, key_enc, iv, enabled)
    VALUES (${userId}, ${cfUid}, ${"youtube"}, ${label}, ${Buffer.from(`url-${cfUid}`)}, ${Buffer.from(`key-${cfUid}`)}, ${Buffer.from(`iv-${cfUid.slice(0, 8)}`)}, ${enabled})
    ON CONFLICT (user_id, label) DO UPDATE SET cf_output_uid = EXCLUDED.cf_output_uid, enabled = EXCLUDED.enabled`;
}

async function seedOpenSession(client: Client, userId: string, uid: string): Promise<string> {
  await requireTables(client, [{ name: "ingest_sessions", owner: S6 }]);
  await requireColumns(
    client,
    "ingest_sessions",
    ["user_id", "cf_input_uid", "started_at", "ended_at", "ended_reason"],
    S6,
  );
  const rows = (await client`INSERT INTO ingest_sessions (user_id, cf_input_uid, started_at)
    VALUES (${userId}, ${uid}, ${new Date(Date.now() - 600000)}) RETURNING id`) as unknown as {
    id: string;
  }[];
  return rows[0]!.id;
}

type InputRow = {
  user_id: string;
  cf_input_uid: string;
  enabled: boolean;
  must_rotate_key?: boolean;
};

async function inputOf(client: Client, userId: string): Promise<InputRow | undefined> {
  const rows = (await client`SELECT user_id, cf_input_uid, enabled FROM stream_live_inputs
    WHERE user_id = ${userId}`) as unknown as InputRow[];
  return rows[0];
}

async function rotationFlag(client: Client, userId: string): Promise<boolean | undefined> {
  await requireColumns(client, "stream_live_inputs", ["must_rotate_key"], S7);
  const rows = (await client`SELECT must_rotate_key FROM stream_live_inputs
    WHERE user_id = ${userId}`) as unknown as { must_rotate_key: boolean }[];
  return rows[0]?.must_rotate_key;
}

async function outputsOf(
  client: Client,
  userId: string,
): Promise<{ cf_output_uid: string; enabled: boolean }[]> {
  return (await client`SELECT cf_output_uid, enabled FROM stream_destinations
    WHERE user_id = ${userId} ORDER BY label`) as unknown as {
    cf_output_uid: string;
    enabled: boolean;
  }[];
}

type SessionRow = {
  id: string;
  user_id: string;
  ended_at: Date | null;
  ended_reason: string | null;
};

async function sessionsOf(client: Client, userId: string): Promise<SessionRow[]> {
  return (await client`SELECT id, user_id, ended_at, ended_reason FROM ingest_sessions
    WHERE user_id = ${userId} ORDER BY started_at`) as unknown as SessionRow[];
}

async function globalSetting(client: Client): Promise<{
  key: string;
  value: { enabled: boolean; disabledAt: string | null; disabledReason: string | null };
} | null> {
  await requireTables(client, [{ name: "stream_settings", owner: S7 }]);
  const rows = (await client`SELECT key, value FROM stream_settings
    WHERE key = 'global'`) as unknown as {
    key: string;
    value: { enabled: boolean; disabledAt: string | null; disabledReason: string | null };
  }[];
  return rows[0] ?? null;
}

type ReportRow = {
  id: string;
  reporter_user_id: string;
  reported_user_id: string;
  session_id: string | null;
  reason: string;
  status: string;
};

async function reportsFor(client: Client, reportedUserId: string): Promise<ReportRow[]> {
  await requireTables(client, [{ name: "stream_reports", owner: S7 }]);
  return (await client`SELECT id, reporter_user_id, reported_user_id, session_id, reason, status
    FROM stream_reports WHERE reported_user_id = ${reportedUserId}`) as unknown as ReportRow[];
}

type NotificationRow = {
  id: string;
  user_id: string;
  kind: string;
  reason: string;
  appeal_path: string | null;
};

async function notificationsFor(client: Client, userId: string): Promise<NotificationRow[]> {
  await requireTables(client, [{ name: "stream_notifications", owner: S7 }]);
  return (await client`SELECT id, user_id, kind, reason, appeal_path FROM stream_notifications
    WHERE user_id = ${userId} ORDER BY created_at`) as unknown as NotificationRow[];
}

type AuditRow = {
  id: number;
  log_name: string;
  description: string;
  subject_type: string | null;
  subject_id: string | null;
  causer_id: string | null;
  properties: Record<string, unknown> | null;
};

async function auditFor(client: Client, causerId: string, subjectId: string): Promise<AuditRow[]> {
  return (await client`SELECT id, log_name, description, subject_type, subject_id, causer_id, properties
    FROM activity_log WHERE causer_id = ${causerId} AND subject_id = ${subjectId}
    ORDER BY id`) as unknown as AuditRow[];
}

const STREAM_TABLES = [
  "stream_reports",
  "stream_notifications",
  "stream_settings",
  "ingest_sessions",
  "stream_destinations",
  "stream_live_inputs",
  "subscriptions",
  "member_links",
];

async function cleanStreaming(client: Client): Promise<void> {
  for (const t of STREAM_TABLES) {
    if (await tableExists(client, t)) await client.unsafe(`DELETE FROM "${t}"`);
  }
}

type TestBindings = Env & {
  SESSION_STORE?: SessionStore;
  ADMIN_DB?: Db;
  THROTTLE_STORE?: () => Promise<unknown>;
  STREAMING_GLOBAL_ENABLED?: string;
  STREAM_API_TOKEN?: string;
};

function bindingsFor(
  fixture: MemberDataFixture,
  sessions: SessionStore,
  extra: Record<string, string> = {},
): TestBindings {
  return {
    ...env,
    SESSION_STORE: sessions,
    ADMIN_DB: fixture.db,
    THROTTLE_STORE: async () => fixture.client,
    STREAM_API_TOKEN: "test-stream-token",
    ...extra,
  } as unknown as TestBindings;
}

function postForm(cookie: string, fields: Record<string, string>, ip: string) {
  return {
    method: "POST" as const,
    headers: {
      cookie,
      origin: env.APP_URL,
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams(fields).toString(),
  };
}

function getPage(cookie: string | null, ip: string) {
  return {
    headers: {
      ...(cookie ? { cookie } : {}),
      accept: "text/html",
      "x-forwarded-for": ip,
    },
  };
}

type CfCall = { method: string; url: string; body: string; authed: boolean };

type CfScenario = {
  live?: boolean;
  failDisableUids?: string[];
  failEnableUids?: string[];
  failOutputUids?: string[];
};

const isDisableCall = (c: CfCall): boolean =>
  c.method === "POST" && c.url.includes("live_inputs") && c.url.includes("disable");
const isEnableCall = (c: CfCall): boolean =>
  c.method === "POST" &&
  c.url.includes("live_inputs") &&
  c.url.includes("enable") &&
  !c.url.includes("disable");
const isOutputPut = (c: CfCall): boolean => c.method === "PUT" && c.url.includes("outputs");
const isStatusGet = (c: CfCall): boolean =>
  c.method === "GET" && c.url.includes("live_inputs") && !c.url.includes("outputs");
const isStreamCall = (c: CfCall): boolean =>
  isDisableCall(c) || isEnableCall(c) || isOutputPut(c) || isStatusGet(c);

function requestedEnabled(body: string): boolean | null {
  try {
    const parsed = JSON.parse(body) as { enabled?: unknown };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

function installCfFake(scenario: CfScenario = {}): { calls: CfCall[] } {
  const calls: CfCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
    init?: { method?: string; headers?: unknown; body?: unknown },
  ) => {
    const url = String(
      typeof input === "string" ? input : ((input as { url?: unknown })?.url ?? input),
    );
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    const body = typeof init?.body === "string" ? init.body : "";
    const call: CfCall = {
      method,
      url,
      body,
      authed: headers.has("authorization") || headers.has("x-auth-key"),
    };
    calls.push(call);
    if (isStatusGet(call)) {
      const live = scenario.live ?? true;
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          status: live ? "connected" : "disconnected",
          live,
          viewers: live ? 3 : 0,
        },
      });
    }
    if (isDisableCall(call)) {
      if (scenario.failDisableUids?.some((u) => url.includes(u))) {
        return Response.json(
          { success: false, errors: ["input disable refused"] },
          { status: 500 },
        );
      }
      return Response.json({ success: true, errors: [], messages: [], result: { enabled: false } });
    }
    if (isEnableCall(call)) {
      if (scenario.failEnableUids?.some((u) => url.includes(u))) {
        return Response.json({ success: false, errors: ["input enable refused"] }, { status: 500 });
      }
      return Response.json({ success: true, errors: [], messages: [], result: { enabled: true } });
    }
    if (isOutputPut(call)) {
      if (scenario.failOutputUids?.some((u) => url.includes(u))) {
        return Response.json(
          { success: false, errors: ["output update refused"] },
          { status: 500 },
        );
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { enabled: requestedEnabled(body) },
      });
    }
    return Response.json(
      { success: false, errors: ["unexpected outbound call in test"] },
      { status: 500 },
    );
  }) as typeof fetch);
  return { calls };
}

/** Inner HTML of the first element tagged with the given testid, or null. */
function taggedInner(html: string, testid: string): string | null {
  const m = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
  ).exec(html);
  return m ? m[2]! : null;
}

function formByTestid(html: string, testid: string): { tag: string; inner: string } | null {
  const tag = new RegExp(`<form\\b[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0];
  if (!tag) return null;
  return { tag, inner: taggedInner(html, testid) ?? "" };
}

function reportAnchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const text = m[2]!.replace(/<[^>]*>/g, "").trim();
    if (/report/i.test(text)) {
      const href = /href="([^"]*)"/.exec(m[1]!)?.[1] ?? "";
      out.push({ href, text });
    }
  }
  return out;
}

const drizzleUrl = new URL("../drizzle/", import.meta.url);
const migrationFiles = () =>
  readdirSync(drizzleUrl)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ name: f, ddl: readFileSync(new URL(f, drizzleUrl), "utf8") }));
const journalTags = (): string[] => {
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", drizzleUrl), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((e) => e.tag);
};

const RUNBOOK_URL = new URL("../docs/streaming-runbooks.md", import.meta.url);
function runbook(): string {
  expect(
    existsSync(RUNBOOK_URL),
    "BUILDER: docs/streaming-runbooks.md missing; merge the K1/K2/key-compromise procedures there",
  ).toBe(true);
  return readFileSync(RUNBOOK_URL, "utf8");
}

describe("streaming kill-switch routes and gates (hermetic)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the admin page, the kill actions and the report intake", () => {
    const routes = rawApp.routes.map((r) => `${r.method} ${r.path}`);
    for (const want of STREAM_ROUTES) expect(routes).toContain(want);
  });

  it("labels every streaming admin route `moderator` in the reviewed inventory", () => {
    const entries = routeInventory(rawApp);
    for (const name of ADMIN_ROUTES) {
      const [method, path] = name.split(" ", 2) as [string, string];
      const entry = entries.find((e) => e.method === method && e.path === path);
      expect(entry?.auth, name).toBe("moderator");
    }
  });

  it("guest admin reads bounce to OAuth", async () => {
    const sessions = createMemorySessionStore();
    const bindings = bindingsFor({ db: undefined } as unknown as MemberDataFixture, sessions);
    const res = await testApp.request("/admin/streaming", getPage(null, freshIp()), bindings);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it.each(ADMIN_ROUTES.filter((r) => r.startsWith("POST")))(
    "guest %s recovers to the streaming admin form",
    async (route) => {
      const sessions = createMemorySessionStore();
      const bindings = bindingsFor({ db: undefined } as unknown as MemberDataFixture, sessions);
      const path = route.split(" ", 2)[1]!;
      const res = await testApp.request(
        path,
        postForm("nonsense", { user_id: "1", reason: "x" }, freshIp()),
        bindings,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fstreaming");
    },
  );

  it("signed non-moderators get 403 on every streaming admin route", async () => {
    const sessions = createMemorySessionStore();
    const bindings = bindingsFor({ db: undefined } as unknown as MemberDataFixture, sessions);
    const cookie = await cookieFor(sessions, {
      userId: "100000000000000102",
      username: "w15-member",
      member: true,
      moderator: false,
    });
    for (const route of ADMIN_ROUTES) {
      const [method, path] = route.split(" ", 2) as [string, string];
      const init =
        method === "GET"
          ? getPage(cookie, freshIp())
          : postForm(cookie, { user_id: "1", reason: "x" }, freshIp());
      const res = await testApp.request(path, init, bindings);
      expect(res.status, route).toBe(403);
      expect(res.headers.get("location"), route).toBeNull();
      expect(await res.text(), route).toContain("You do not have access to this");
    }
  });

  it("guest member writes recover to their form pages", async () => {
    const sessions = createMemorySessionStore();
    const bindings = bindingsFor({ db: undefined } as unknown as MemberDataFixture, sessions);
    const disable = await testApp.request(
      "/streaming/setup/disable",
      postForm("nonsense", {}, freshIp()),
      bindings,
    );
    expect(disable.status).toBe(303);
    expect(disable.headers.get("location")).toBe("/auth/recover?next=%2Fstreaming%2Fsetup");
    const report = await testApp.request(
      "/streaming/reports",
      postForm("nonsense", { reason: "x" }, freshIp()),
      bindings,
    );
    expect(report.status).toBe(303);
    expect(report.headers.get("location")).toBe("/auth/recover?next=%2Fstreaming%2Freports%2Fnew");
  });

  it("guests read no report form", async () => {
    const sessions = createMemorySessionStore();
    const bindings = bindingsFor({ db: undefined } as unknown as MemberDataFixture, sessions);
    const res = await testApp.request("/streaming/reports/new", getPage(null, freshIp()), bindings);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it("signed non-members get 403 on the member kill and report routes", async () => {
    const sessions = createMemorySessionStore();
    const bindings = bindingsFor({ db: undefined } as unknown as MemberDataFixture, sessions);
    const cookie = await cookieFor(sessions, OUTSIDER);
    expect(
      (await testApp.request("/streaming/reports/new", getPage(cookie, freshIp()), bindings))
        .status,
    ).toBe(403);
    expect(
      (await testApp.request("/streaming/setup/disable", postForm(cookie, {}, freshIp()), bindings))
        .status,
    ).toBe(403);
    expect(
      (
        await testApp.request(
          "/streaming/reports",
          postForm(cookie, { reason: "x" }, freshIp()),
          bindings,
        )
      ).status,
    ).toBe(403);
  });
});

describe("streaming kill-switch gate wiring (hermetic)", () => {
  it("a11y coverage audits the streaming admin page and the report form", () => {
    const table = coverage as Record<string, { skip?: unknown; cases?: { path: string }[] }>;
    for (const route of ["/admin/streaming", "/streaming/reports/new"]) {
      expect(table[route]?.skip, `${route} must not be skipped`).toBeFalsy();
      expect(table[route]?.cases?.length ?? 0, `${route} needs audit cases`).toBeGreaterThan(0);
    }
    const scenarios = auditCases(rawApp.routes, coverage) as { route: string }[];
    const routes = scenarios.map((s) => s.route);
    expect(routes).toContain("/admin/streaming");
    expect(routes).toContain("/streaming/reports/new");
  });
});

describe("streaming runbooks and admin guide (hermetic)", () => {
  it("merges the K1 per-member runbook as operable steps", () => {
    const doc = runbook();
    expect(doc).toMatch(/## .*K1/s);
    expect(doc).toMatch(/Disable streaming/);
    expect(doc).toMatch(/kill_switch/);
    expect(doc).toMatch(/rotate/i);
    expect(doc).toMatch(/appeal/i);
    expect(doc).toMatch(/audit/i);
  });

  it("merges the K2 global runbook with flag, mass-disable and comms", () => {
    const doc = runbook();
    expect(doc).toMatch(/## .*K2/s);
    expect(doc).toMatch(/streaming_global_enabled/);
    expect(doc).toMatch(/Disable all/);
    expect(doc).toMatch(/freeze/i);
    expect(doc).toMatch(/24h/);
  });

  it("merges the key-compromise procedure", () => {
    const doc = runbook();
    expect(doc).toMatch(/key-compromis|compromised key/i);
    expect(doc).toMatch(/Rotate/i);
  });

  it("carries the strike policy and flags the owner/legal Terms update", () => {
    const doc = runbook();
    expect(doc).toMatch(/7-day/);
    expect(doc).toMatch(/90-day/);
    expect(doc).toMatch(/pro-rata/i);
    expect(doc).toMatch(/ToS|terms of service/i);
    expect(doc).toMatch(/owner/i);
    expect(doc).toMatch(/legal/i);
  });

  it("records a completed staging drill over K1 and K2", () => {
    const doc = runbook();
    expect(doc).toMatch(/## .*drill/i);
    expect(doc).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(doc).toMatch(/K1/);
    expect(doc).toMatch(/K2/);
    expect(doc).toMatch(/pass/i);
  });

  it("carries no secrets and no tracker ids", () => {
    const doc = runbook();
    expect(doc).not.toMatch(/sk_live|BEGIN [A-Z ]*PRIVATE KEY/);
    expect(doc).not.toMatch(/[A-Z]+-\d+/);
  });

  it("the moderator admin guide lists the streaming admin routes", () => {
    const guide = readFileSync(
      new URL("../docs/moderator-admin-guide.md", import.meta.url),
      "utf8",
    );
    expect(guide).toContain("/admin/streaming");
    expect(guide).toMatch(/kill switch/i);
  });
});

describe("streaming kill-switch migration files (hermetic)", () => {
  it("a journaled migration creates stream_reports with the contract shape", () => {
    const hits = migrationFiles().filter((f) => /create\s+table[^;]*stream_reports/is.test(f.ddl));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ddl = hits[0]!.ddl;
    for (const col of [
      "reporter_user_id",
      "reported_user_id",
      "session_id",
      "reason",
      "status",
      "created_at",
    ]) {
      expect(ddl, col).toMatch(new RegExp(col, "i"));
    }
    expect(ddl).toMatch(/default\s+'open'/i);
    expect(journalTags()).toContain(hits[0]!.name.replace(/\.sql$/, ""));
  });

  it("a journaled migration creates stream_notifications with the contract shape", () => {
    const hits = migrationFiles().filter((f) =>
      /create\s+table[^;]*stream_notifications/is.test(f.ddl),
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ddl = hits[0]!.ddl;
    for (const col of ["user_id", "kind", "reason", "appeal_path", "created_at"]) {
      expect(ddl, col).toMatch(new RegExp(col, "i"));
    }
    expect(journalTags()).toContain(hits[0]!.name.replace(/\.sql$/, ""));
  });

  it("a journaled migration creates stream_settings with a keyed JSON value", () => {
    const hits = migrationFiles().filter((f) => /create\s+table[^;]*stream_settings/is.test(f.ddl));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ddl = hits[0]!.ddl;
    expect(ddl).toMatch(/key\s+text/i);
    expect(ddl).toMatch(/value\s+jsonb/i);
    expect(ddl).toMatch(/updated_at/i);
    expect(journalTags()).toContain(hits[0]!.name.replace(/\.sql$/, ""));
  });

  it("a journaled migration adds the forced-rotation flag to live inputs", () => {
    const hits = migrationFiles().filter((f) =>
      /alter\s+table[^;]*stream_live_inputs[^;]*must_rotate_key/is.test(f.ddl),
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.ddl).toMatch(/boolean/i);
    expect(hits[0]!.ddl).toMatch(/default\s+false/i);
    expect(journalTags()).toContain(hits[0]!.name.replace(/\.sql$/, ""));
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "streaming kill switches: behavior (disposable Postgres, fetch fakes)",
  () => {
    let fixture: MemberDataFixture;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanStreaming(fixture.client);
      await fixture.reset();
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    async function setup() {
      const sessions = createMemorySessionStore();
      const bindings = bindingsFor(fixture, sessions);
      const ip = freshIp();
      await seedUsers(fixture.client, [MODERATOR]);
      const modCookie = await cookieFor(sessions, MODERATOR);
      return { sessions, bindings, ip, modCookie };
    }

    async function subscriber(
      sessions: SessionStore,
      username: string,
      opts: {
        tier?: string;
        status?: string;
        inputUid?: string;
        inputEnabled?: boolean;
        outputs?: { label: string; uid: string; enabled?: boolean }[];
        live?: boolean;
      } = {},
    ): Promise<{ actor: Actor; cookie: string; inputUid: string; sessionId: string | null }> {
      const actor = memberActor(username);
      await seedUsers(fixture.client, [actor]);
      await seedProfile(fixture.client, actor.userId);
      await seedSubscription(fixture.client, actor.userId, opts.tier, opts.status);
      const inputUid = opts.inputUid ?? `cf-input-${actor.userId.slice(-6)}`;
      await seedInput(fixture.client, actor.userId, inputUid, opts.inputEnabled);
      for (const o of opts.outputs ?? []) {
        await seedOutput(fixture.client, actor.userId, o.label, o.uid, o.enabled);
      }
      const sessionId =
        opts.live === false ? null : await seedOpenSession(fixture.client, actor.userId, inputUid);
      const cookie = await cookieFor(sessions, actor);
      return { actor, cookie, inputUid, sessionId };
    }

    describe("moderator admin page", () => {
      it("renders the console: status, five action forms, reports and strike copy", async () => {
        const h = await setup();
        const res = await testApp.request(
          "/admin/streaming",
          getPage(h.modCookie, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        await requireTables(fixture.client, [
          { name: "stream_settings", owner: S7 },
          { name: "stream_reports", owner: S7 },
        ]);
        const html = await res.text();
        expect(html).toContain('<meta name="viewport"');
        const status = taggedInner(html, "global-status");
        expect(status).not.toBeNull();
        expect(status).toMatch(/Enabled/);
        const forms: [string, string, string[]][] = [
          ["k1-disable-form", "/admin/streaming/disable", ["user_id", "reason"]],
          ["k1-enable-form", "/admin/streaming/enable", ["user_id"]],
          ["k2-disable-form", "/admin/streaming/global/disable", ["reason"]],
          ["k2-enable-form", "/admin/streaming/global/enable", []],
          ["k2-notify-form", "/admin/streaming/global/notify", []],
        ];
        for (const [testid, action, fields] of forms) {
          const form = formByTestid(html, testid);
          expect(form, testid).not.toBeNull();
          expect(form!.tag).toMatch(/method="post"/i);
          expect(form!.tag).toContain(`action="${action}"`);
          for (const field of fields)
            expect(form!.inner, `${testid}.${field}`).toContain(`name="${field}"`);
        }
        expect(taggedInner(html, "streaming-reports")).not.toBeNull();
        const strikes = taggedInner(html, "strike-policy");
        expect(strikes).not.toBeNull();
        expect(strikes).toMatch(/7-day/);
        expect(strikes).toMatch(/90-day/);
        expect(strikes).toMatch(/pro-rata/i);
      });
    });

    describe("K1 moderator kill", () => {
      it("confirms with the runbook copy after faking input and outputs off, in order", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer01", {
          outputs: [
            { label: "Tube", uid: "cf-out-k1a-tube" },
            { label: "Twitch", uid: "cf-out-k1a-twitch" },
          ],
        });
        const reason = "spam simulcast case k1a";
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/admin/streaming/disable",
          postForm(h.modCookie, { user_id: target.actor.userId, reason }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(taggedInner(html, "k1-result")).not.toBeNull();
        expect(html).toMatch(
          new RegExp(`Streaming disabled for @${target.actor.username} at \\d\\d:\\d\\d UTC`),
        );
        const disables = calls.filter(isDisableCall);
        expect(disables).toHaveLength(1);
        expect(disables[0]!.url).toContain(target.inputUid);
        const puts = calls.filter(isOutputPut);
        expect(puts).toHaveLength(2);
        expect(puts.map((c) => requestedEnabled(c.body))).toEqual([false, false]);
        expect(calls.map((c) => c.url)).toEqual(
          expect.arrayContaining([expect.stringContaining("cf-out-k1a-tube")]),
        );
        const order = calls.map((c) =>
          isDisableCall(c) ? "input" : isOutputPut(c) ? "out" : "other",
        );
        expect(order[0]).toBe("input");
        expect(order.filter((k) => k === "other")).toHaveLength(0);
        for (const c of calls.filter(isStreamCall)) expect(c.authed).toBe(true);
        expect(calls.some((c) => !isStreamCall(c))).toBe(false);
      });

      it("lands input, outputs, session close, audit and member notice", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer02", {
          outputs: [{ label: "Tube", uid: "cf-out-k1b-tube" }],
        });
        const control = await subscriber(h.sessions, "killcontrol02", {
          outputs: [{ label: "Tube", uid: "cf-out-k1b-control" }],
        });
        const reason = "hate raid case k1b";
        installCfFake();
        const res = await testApp.request(
          "/admin/streaming/disable",
          postForm(h.modCookie, { user_id: target.actor.userId, reason }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        await requireTables(fixture.client, [
          { name: "stream_live_inputs", owner: S3 },
          { name: "stream_destinations", owner: S4 },
          { name: "ingest_sessions", owner: S6 },
          { name: "stream_notifications", owner: S7 },
        ]);
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(false);
        expect(await outputsOf(fixture.client, target.actor.userId)).toEqual([
          { cf_output_uid: "cf-out-k1b-tube", enabled: false },
        ]);
        const sessions = await sessionsOf(fixture.client, target.actor.userId);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.ended_reason).toBe("kill_switch");
        expect(sessions[0]!.ended_at).not.toBeNull();
        expect((await inputOf(fixture.client, control.actor.userId))?.enabled).toBe(true);
        const controlSessions = await sessionsOf(fixture.client, control.actor.userId);
        expect(controlSessions).toHaveLength(1);
        expect(controlSessions[0]!.ended_at).toBeNull();
        const audit = await auditFor(fixture.client, MODERATOR.userId, target.actor.userId);
        expect(audit.length).toBeGreaterThanOrEqual(1);
        const row = audit[audit.length - 1]!;
        expect(row.log_name).toBe("streaming");
        expect(row.subject_type).toBe("stream_live_input");
        expect(JSON.stringify(row.properties)).toContain(target.inputUid);
        expect(`${row.description} ${JSON.stringify(row.properties)}`).toContain(reason);
        const notices = await notificationsFor(fixture.client, target.actor.userId);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ kind: "kill_notice", reason });
        expect(notices[0]!.appeal_path).toBeTruthy();
        expect(await notificationsFor(fixture.client, control.actor.userId)).toHaveLength(0);
      });

      it("shows the killed member their reason, appeal path and strike copy", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer03");
        const reason = "restreamed paid match case k1c";
        installCfFake();
        const kill = await testApp.request(
          "/admin/streaming/disable",
          postForm(h.modCookie, { user_id: target.actor.userId, reason }, h.ip),
          h.bindings,
        );
        expect(kill.status).toBe(200);
        const page = await testApp.request(
          "/streaming/setup",
          getPage(target.cookie, h.ip),
          h.bindings,
        );
        expect(page.status).toBe(200);
        const html = await page.text();
        const notice = taggedInner(html, "streaming-kill-notice");
        expect(notice).not.toBeNull();
        expect(notice).toContain(reason);
        expect(notice).toMatch(/appeal/i);
        expect(notice).toMatch(/7-day/);
      });

      it("kills an offline input with no open session", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer04", { live: false });
        installCfFake();
        const res = await testApp.request(
          "/admin/streaming/disable",
          postForm(
            h.modCookie,
            { user_id: target.actor.userId, reason: "preemptive case k1d" },
            h.ip,
          ),
          h.bindings,
        );
        expect(res.status).toBe(200);
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(false);
        expect(await sessionsOf(fixture.client, target.actor.userId)).toHaveLength(0);
        expect(await notificationsFor(fixture.client, target.actor.userId)).toHaveLength(1);
      });

      it("double kill is idempotent", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer05");
        installCfFake();
        const fields = { user_id: target.actor.userId, reason: "repeat case k1e" };
        expect(
          (
            await testApp.request(
              "/admin/streaming/disable",
              postForm(h.modCookie, fields, h.ip),
              h.bindings,
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await testApp.request(
              "/admin/streaming/disable",
              postForm(h.modCookie, fields, h.ip),
              h.bindings,
            )
          ).status,
        ).toBe(200);
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(false);
        const sessions = await sessionsOf(fixture.client, target.actor.userId);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.ended_reason).toBe("kill_switch");
      });

      it("unknown streamers are 404 without touching the fake", async () => {
        const h = await setup();
        const stranger = memberActor("neverstreams06");
        await seedUsers(fixture.client, [stranger]);
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/admin/streaming/disable",
          postForm(h.modCookie, { user_id: stranger.userId, reason: "ghost case k1f" }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toMatch(/no streaming input|no input|not streaming/i);
        expect(calls).toHaveLength(0);
      });

      it("a missing reason is 422 and changes nothing", async () => {
        const h = await setup();
        for (const [tag, fields] of [
          ["absent", { user_id: "" }],
          ["blank", { user_id: "", reason: "   " }],
        ] as const) {
          const target = await subscriber(h.sessions, `killstreamer07${tag}`);
          const before = await sessionsOf(fixture.client, target.actor.userId);
          const { calls } = installCfFake();
          const res = await testApp.request(
            "/admin/streaming/disable",
            postForm(h.modCookie, { ...fields, user_id: target.actor.userId }, h.ip),
            h.bindings,
          );
          expect(res.status, tag).toBe(422);
          expect(res.headers.get("content-type"), tag).toContain("text/html");
          expect(await res.text(), tag).toContain('role="alert"');
          expect(calls, tag).toHaveLength(0);
          expect((await inputOf(fixture.client, target.actor.userId))?.enabled, tag).toBe(true);
          expect(await sessionsOf(fixture.client, target.actor.userId), tag).toEqual(before);
          expect(
            await auditFor(fixture.client, MODERATOR.userId, target.actor.userId),
            tag,
          ).toHaveLength(0);
          expect(await notificationsFor(fixture.client, target.actor.userId), tag).toHaveLength(0);
        }
      });

      it("a Cloudflare input failure is 502 with the database untouched", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer08", {
          outputs: [{ label: "Tube", uid: "cf-out-k1h-tube" }],
        });
        const { calls } = installCfFake({ failDisableUids: [target.inputUid] });
        const res = await testApp.request(
          "/admin/streaming/disable",
          postForm(
            h.modCookie,
            { user_id: target.actor.userId, reason: "upstream down case k1h" },
            h.ip,
          ),
          h.bindings,
        );
        expect(res.status).toBe(502);
        expect(await res.text()).toMatch(/failed|error|not disabled/i);
        expect(calls.filter(isDisableCall)).toHaveLength(1);
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(true);
        expect(await outputsOf(fixture.client, target.actor.userId)).toEqual([
          { cf_output_uid: "cf-out-k1h-tube", enabled: true },
        ]);
        const sessions = await sessionsOf(fixture.client, target.actor.userId);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.ended_at).toBeNull();
        expect(await auditFor(fixture.client, MODERATOR.userId, target.actor.userId)).toHaveLength(
          0,
        );
        expect(await notificationsFor(fixture.client, target.actor.userId)).toHaveLength(0);
      });

      it("a failed output names the output and leaves the database enabled", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "killstreamer09", {
          outputs: [
            { label: "Tube", uid: "cf-out-k1i-tube" },
            { label: "Twitch", uid: "cf-out-k1i-twitch" },
          ],
        });
        installCfFake({ failOutputUids: ["cf-out-k1i-twitch"] });
        const res = await testApp.request(
          "/admin/streaming/disable",
          postForm(h.modCookie, { user_id: target.actor.userId, reason: "partial case k1i" }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(502);
        expect(await res.text()).toContain("cf-out-k1i-twitch");
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(true);
        expect(await auditFor(fixture.client, MODERATOR.userId, target.actor.userId)).toHaveLength(
          0,
        );
      });
    });

    describe("K1 member self-disable", () => {
      it("disables only the caller's input, then lands on setup with the notice", async () => {
        const h = await setup();
        const self = await subscriber(h.sessions, "selfkillstreamer10", {
          outputs: [{ label: "Tube", uid: "cf-out-s10-tube" }],
        });
        const other = await subscriber(h.sessions, "selfkillcontrol10", {
          outputs: [{ label: "Tube", uid: "cf-out-s10-control" }],
        });
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/streaming/setup/disable",
          postForm(self.cookie, { reason: "key leaked case s10" }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe("/streaming/setup");
        expect(calls.filter(isDisableCall)).toHaveLength(1);
        expect(calls.filter(isDisableCall)[0]!.url).toContain(self.inputUid);
        expect((await inputOf(fixture.client, self.actor.userId))?.enabled).toBe(false);
        expect((await inputOf(fixture.client, other.actor.userId))?.enabled).toBe(true);
        const sessions = await sessionsOf(fixture.client, self.actor.userId);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.ended_reason).toBe("kill_switch");
        const page = await testApp.request(
          "/streaming/setup",
          getPage(self.cookie, h.ip),
          h.bindings,
        );
        expect(taggedInner(await page.text(), "streaming-kill-notice")).not.toBeNull();
      });

      it("a member without streaming gets 404, not someone else's kill", async () => {
        const h = await setup();
        const plain = memberActor("plainmember11");
        await seedUsers(fixture.client, [plain]);
        await seedProfile(fixture.client, plain.userId);
        const cookie = await cookieFor(h.sessions, plain);
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/streaming/setup/disable",
          postForm(cookie, {}, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toMatch(/no streaming input|no input|not streaming|subscription/i);
        expect(calls).toHaveLength(0);
      });
    });

    describe("K1 re-enable", () => {
      it("reverses the kill and forces key rotation", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "rekillstreamer12", {
          outputs: [{ label: "Tube", uid: "cf-out-r12-tube" }],
        });
        installCfFake();
        const kill = await testApp.request(
          "/admin/streaming/disable",
          postForm(h.modCookie, { user_id: target.actor.userId, reason: "rotate case r12" }, h.ip),
          h.bindings,
        );
        expect(kill.status).toBe(200);
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/admin/streaming/enable",
          postForm(h.modCookie, { user_id: target.actor.userId }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/re-?enabled/i);
        expect(html).toContain(`@${target.actor.username}`);
        const enables = calls.filter(isEnableCall);
        expect(enables).toHaveLength(1);
        expect(enables[0]!.url).toContain(target.inputUid);
        const puts = calls.filter(isOutputPut);
        expect(puts).toHaveLength(1);
        expect(puts.map((c) => requestedEnabled(c.body))).toEqual([true]);
        const order = calls.map((c) =>
          isEnableCall(c) ? "input" : isOutputPut(c) ? "out" : "other",
        );
        expect(order[0]).toBe("input");
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(true);
        expect(await rotationFlag(fixture.client, target.actor.userId)).toBe(true);
        expect(await outputsOf(fixture.client, target.actor.userId)).toEqual([
          { cf_output_uid: "cf-out-r12-tube", enabled: true },
        ]);
        expect(await sessionsOf(fixture.client, target.actor.userId)).toHaveLength(1);
        const audit = await auditFor(fixture.client, MODERATOR.userId, target.actor.userId);
        expect(audit.length).toBeGreaterThanOrEqual(2);
        const page = await testApp.request(
          "/streaming/setup",
          getPage(target.cookie, h.ip),
          h.bindings,
        );
        const setupHtml = await page.text();
        const rotate = taggedInner(setupHtml, "streaming-rotate-required");
        expect(rotate).not.toBeNull();
        expect(rotate).toMatch(/rotat/i);
      });

      it("enabling an already-enabled input is a safe no-op", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "rekillstreamer13");
        installCfFake();
        const res = await testApp.request(
          "/admin/streaming/enable",
          postForm(h.modCookie, { user_id: target.actor.userId }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(true);
        expect(await rotationFlag(fixture.client, target.actor.userId)).toBe(false);
      });
    });

    describe("K2 global flag", () => {
      it.each([
        ["false", 503],
        ["0", 503],
      ])(
        "STREAMING_GLOBAL_ENABLED=%s blocks setup writes with the outage banner on reads",
        async (value, status) => {
          const sessions = createMemorySessionStore();
          const bindings = bindingsFor(fixture, sessions, { STREAMING_GLOBAL_ENABLED: value });
          const ip = freshIp();
          await seedUsers(fixture.client, [MODERATOR]);
          const target = await subscriber(sessions, `flagstreamer14${value}`);
          installCfFake();
          const write = await testApp.request(
            "/streaming/setup/disable",
            postForm(target.cookie, {}, ip),
            bindings,
          );
          expect(write.status).toBe(status);
          expect(await write.text()).toMatch(/maintenance|temporarily|disabled/i);
          const read = await testApp.request(
            "/streaming/setup",
            getPage(target.cookie, ip),
            bindings,
          );
          expect(read.status).toBe(200);
          const banner = taggedInner(await read.text(), "streaming-outage-banner");
          expect(banner).not.toBeNull();
          expect(banner).toMatch(/maintenance|temporarily/i);
        },
      );

      it.each([["unset", undefined]])(
        "STREAMING_GLOBAL_ENABLED %s leaves setup writes working",
        async (_label, value) => {
          const sessions = createMemorySessionStore();
          const bindings = bindingsFor(
            fixture,
            sessions,
            value ? { STREAMING_GLOBAL_ENABLED: value } : {},
          );
          const ip = freshIp();
          await seedUsers(fixture.client, [MODERATOR]);
          const target = await subscriber(sessions, "flagstreamer15unset");
          installCfFake();
          const write = await testApp.request(
            "/streaming/setup/disable",
            postForm(target.cookie, {}, ip),
            bindings,
          );
          expect(write.status).toBe(303);
        },
      );

      it.each([["true"], ["1"], ["yes"]])(
        "STREAMING_GLOBAL_ENABLED=%s leaves setup writes working",
        async (value) => {
          const sessions = createMemorySessionStore();
          const bindings = bindingsFor(fixture, sessions, { STREAMING_GLOBAL_ENABLED: value });
          const ip = freshIp();
          await seedUsers(fixture.client, [MODERATOR]);
          const target = await subscriber(sessions, `flagstreamer15${value}`);
          installCfFake();
          const write = await testApp.request(
            "/streaming/setup/disable",
            postForm(target.cookie, {}, ip),
            bindings,
          );
          expect(write.status).toBe(303);
        },
      );

      it("flagged-off live pages render the maintenance note, never the banner when on", async () => {
        const offSessions = createMemorySessionStore();
        const offBindings = bindingsFor(fixture, offSessions, {
          STREAMING_GLOBAL_ENABLED: "false",
        });
        const offIp = freshIp();
        await seedUsers(fixture.client, [MODERATOR]);
        const target = await subscriber(offSessions, "flagstreamer16");
        const off = await testApp.request(
          `/members/${target.actor.userId}/live`,
          getPage(null, offIp),
          offBindings,
        );
        expect(off.status).toBe(200);
        const offHtml = await off.text();
        expect(offHtml).toMatch(/maintenance/i);
        expect(taggedInner(offHtml, "streaming-outage-banner")).not.toBeNull();
        const onSessions = createMemorySessionStore();
        const onBindings = bindingsFor(fixture, onSessions);
        const on = await testApp.request(
          `/members/${target.actor.userId}/live`,
          getPage(null, freshIp()),
          onBindings,
        );
        expect(on.status).toBe(200);
        expect(taggedInner(await on.text(), "streaming-outage-banner")).toBeNull();
      });
    });

    describe("K2 mass disable and notify", () => {
      it("lists per-input results, persists the outage and skips kill notices", async () => {
        const h = await setup();
        const good = await subscriber(h.sessions, "massgood17", {
          outputs: [{ label: "Tube", uid: "cf-out-m17-good" }],
        });
        const bad = await subscriber(h.sessions, "massbad17", {
          outputs: [{ label: "Tube", uid: "cf-out-m17-bad" }],
        });
        const reason = "platform abuse wave case m17";
        installCfFake({ failDisableUids: [bad.inputUid] });
        const res = await testApp.request(
          "/admin/streaming/global/disable",
          postForm(h.modCookie, { reason }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        const results = taggedInner(html, "k2-mass-results");
        expect(results).not.toBeNull();
        expect(results).toContain(good.inputUid);
        expect(results).toContain(bad.inputUid);
        expect(results).toMatch(/success/i);
        expect(results).toMatch(/fail/i);
        const setting = await globalSetting(fixture.client);
        expect(setting?.value.enabled).toBe(false);
        expect(setting?.value.disabledReason).toBe(reason);
        expect(setting?.value.disabledAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect((await inputOf(fixture.client, good.actor.userId))?.enabled).toBe(false);
        expect((await sessionsOf(fixture.client, good.actor.userId))[0]?.ended_reason).toBe(
          "kill_switch",
        );
        expect((await inputOf(fixture.client, bad.actor.userId))?.enabled).toBe(true);
        expect((await sessionsOf(fixture.client, bad.actor.userId))[0]?.ended_at).toBeNull();
        const audit = await auditFor(fixture.client, MODERATOR.userId, "global");
        expect(audit.length).toBeGreaterThanOrEqual(1);
        const row = audit[audit.length - 1]!;
        expect(row.log_name).toBe("streaming");
        expect(`${row.description} ${JSON.stringify(row.properties)}`).toContain(reason);
        expect(JSON.stringify(row.properties)).toContain(good.inputUid);
        expect(JSON.stringify(row.properties)).toContain(bad.inputUid);
        expect(await notificationsFor(fixture.client, good.actor.userId)).toHaveLength(0);
        expect(await notificationsFor(fixture.client, bad.actor.userId)).toHaveLength(0);
        const statusPage = await testApp.request(
          "/admin/streaming",
          getPage(h.modCookie, h.ip),
          h.bindings,
        );
        const status = taggedInner(await statusPage.text(), "global-status");
        expect(status).toMatch(/Disabled/);
        expect(status).toContain(reason);
        const memberPage = await testApp.request(
          "/streaming/setup",
          getPage(good.cookie, h.ip),
          h.bindings,
        );
        const memberHtml = await memberPage.text();
        expect(taggedInner(memberHtml, "streaming-outage-banner")).not.toBeNull();
        expect(taggedInner(memberHtml, "streaming-kill-notice")).toBeNull();
      });

      it("a missing reason is 422 and changes nothing", async () => {
        const h = await setup();
        const target = await subscriber(h.sessions, "massreason18");
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/admin/streaming/global/disable",
          postForm(h.modCookie, {}, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(422);
        expect(await res.text()).toContain('role="alert"');
        expect(calls).toHaveLength(0);
        expect((await inputOf(fixture.client, target.actor.userId))?.enabled).toBe(true);
        expect(await globalSetting(fixture.client)).toBeNull();
      });

      it("re-running the global kill is safe", async () => {
        const h = await setup();
        await subscriber(h.sessions, "massrepeat19");
        installCfFake();
        const fields = { reason: "repeat drill case m19" };
        expect(
          (
            await testApp.request(
              "/admin/streaming/global/disable",
              postForm(h.modCookie, fields, h.ip),
              h.bindings,
            )
          ).status,
        ).toBe(200);
        const again = await testApp.request(
          "/admin/streaming/global/disable",
          postForm(h.modCookie, fields, h.ip),
          h.bindings,
        );
        expect(again.status).toBe(200);
        expect(taggedInner(await again.text(), "k2-mass-results")).not.toBeNull();
        expect((await globalSetting(fixture.client))?.value.enabled).toBe(false);
      });

      it("a global kill with zero inputs still records the outage", async () => {
        const h = await setup();
        installCfFake();
        const res = await testApp.request(
          "/admin/streaming/global/disable",
          postForm(h.modCookie, { reason: "empty drill case m20" }, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        expect(taggedInner(await res.text(), "k2-mass-results")).not.toBeNull();
        expect((await globalSetting(fixture.client))?.value.enabled).toBe(false);
      });

      it("notify queues one outage email per active subscriber", async () => {
        const h = await setup();
        const active = await subscriber(h.sessions, "notifyactive21");
        const canceled = await subscriber(h.sessions, "notifycanceled21", { status: "canceled" });
        const pastDue = await subscriber(h.sessions, "notifypastdue21", { status: "past_due" });
        const paused = await subscriber(h.sessions, "notifypaused21", { status: "paused" });
        installCfFake();
        const res = await testApp.request(
          "/admin/streaming/global/notify",
          postForm(h.modCookie, {}, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(taggedInner(html, "k2-notify-result")).not.toBeNull();
        expect(html).toMatch(/email|notif/i);
        const rows = await notificationsFor(fixture.client, active.actor.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe("outage_email");
        expect(await notificationsFor(fixture.client, canceled.actor.userId)).toHaveLength(0);
        expect(await notificationsFor(fixture.client, pastDue.actor.userId)).toHaveLength(0);
        expect(await notificationsFor(fixture.client, paused.actor.userId)).toHaveLength(0);
        const audit = await auditFor(fixture.client, MODERATOR.userId, "global");
        expect(audit.length).toBeGreaterThanOrEqual(1);
      });

      it("notify with no active subscribers queues nothing", async () => {
        const h = await setup();
        await subscriber(h.sessions, "notifyempty22", { status: "canceled" });
        installCfFake();
        const res = await testApp.request(
          "/admin/streaming/global/notify",
          postForm(h.modCookie, {}, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const rows = (await fixture.client`SELECT id FROM stream_notifications`) as unknown as {
          id: string;
        }[];
        expect(rows).toHaveLength(0);
      });
    });

    describe("K2 recovery", () => {
      it("re-enables active-only inputs, forces rotation and verifies samples", async () => {
        const h = await setup();
        const actives = [];
        for (const name of [
          "recactive23a",
          "recactive23b",
          "recactive23c",
          "recactive23d",
          "recactive23e",
        ]) {
          actives.push(
            await subscriber(h.sessions, name, {
              outputs: [{ label: "Tube", uid: `cf-out-r23-${name.slice(-1)}` }],
            }),
          );
        }
        const canceled = await subscriber(h.sessions, "reccanceled23", { status: "canceled" });
        const paused = await subscriber(h.sessions, "recpaused23", { status: "paused" });
        installCfFake();
        const down = await testApp.request(
          "/admin/streaming/global/disable",
          postForm(h.modCookie, { reason: "recovery drill case r23" }, h.ip),
          h.bindings,
        );
        expect(down.status).toBe(200);
        const { calls } = installCfFake();
        const res = await testApp.request(
          "/admin/streaming/global/enable",
          postForm(h.modCookie, {}, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        const samples = taggedInner(html, "k2-verify-samples");
        expect(samples).not.toBeNull();
        expect(samples).toMatch(/verif/i);
        const named = actives.filter((a) => samples!.includes(a.inputUid));
        expect(named.length).toBeGreaterThanOrEqual(3);
        expect(html).toContain(canceled.actor.userId);
        expect(html).toContain(paused.actor.userId);
        const setting = await globalSetting(fixture.client);
        expect(setting?.value.enabled).toBe(true);
        expect(setting?.value.disabledAt).toBeNull();
        for (const a of actives) {
          expect((await inputOf(fixture.client, a.actor.userId))?.enabled, a.actor.username).toBe(
            true,
          );
          expect(await rotationFlag(fixture.client, a.actor.userId), a.actor.username).toBe(true);
        }
        expect((await inputOf(fixture.client, canceled.actor.userId))?.enabled).toBe(false);
        expect((await inputOf(fixture.client, paused.actor.userId))?.enabled).toBe(false);
        expect(await rotationFlag(fixture.client, canceled.actor.userId)).toBe(false);
        const enables = calls.filter(isEnableCall);
        expect(enables).toHaveLength(5);
        for (const a of actives) {
          expect(
            enables.some((c) => c.url.includes(a.inputUid)),
            a.inputUid,
          ).toBe(true);
        }
        expect(calls.filter(isStatusGet).length).toBeGreaterThanOrEqual(3);
        const audit = await auditFor(fixture.client, MODERATOR.userId, "global");
        expect(audit.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe("abuse reports", () => {
      it("members get the report form with the streamer prefilled", async () => {
        const h = await setup();
        const reporter = memberActor("reporter24");
        const streamer = memberActor("reportedstreamer24");
        await seedUsers(fixture.client, [reporter, streamer]);
        const cookie = await cookieFor(h.sessions, reporter);
        const res = await testApp.request(
          `/streaming/reports/new?user=${streamer.userId}`,
          getPage(cookie, h.ip),
          h.bindings,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        const form = formByTestid(html, "stream-report-form");
        expect(form).not.toBeNull();
        expect(form!.tag).toMatch(/method="post"/i);
        expect(form!.tag).toContain('action="/streaming/reports"');
        for (const field of ["reported_user_id", "session_id", "reason"]) {
          expect(form!.inner, field).toContain(`name="${field}"`);
        }
        expect(form!.inner).toContain(streamer.userId);
      });

      it("a report lands in the moderator queue with full stream context", async () => {
        const h = await setup();
        const reporter = memberActor("reporter25");
        await seedUsers(fixture.client, [reporter]);
        await seedProfile(fixture.client, reporter.userId);
        const reporterCookie = await cookieFor(h.sessions, reporter);
        const streamer = await subscriber(h.sessions, "reportedstreamer25");
        const reason = "restreamed my set case ab25";
        const res = await testApp.request(
          "/streaming/reports",
          postForm(
            reporterCookie,
            {
              reported_user_id: streamer.actor.userId,
              session_id: streamer.sessionId!,
              reason,
            },
            h.ip,
          ),
          h.bindings,
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(`/members/${streamer.actor.userId}/live`);
        const rows = await reportsFor(fixture.client, streamer.actor.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          reporter_user_id: reporter.userId,
          reported_user_id: streamer.actor.userId,
          session_id: streamer.sessionId,
          reason,
          status: "open",
        });
        const queue = await testApp.request(
          "/admin/streaming",
          getPage(h.modCookie, h.ip),
          h.bindings,
        );
        const block = taggedInner(await queue.text(), "streaming-reports");
        expect(block).not.toBeNull();
        expect(block).toContain(streamer.actor.username);
        expect(block).toContain(reason);
        expect(block).toContain(streamer.sessionId!);
      });

      it("a report without a reason is 422 with the draft preserved", async () => {
        const h = await setup();
        const reporter = memberActor("reporter26");
        await seedUsers(fixture.client, [reporter]);
        const reporterCookie = await cookieFor(h.sessions, reporter);
        const streamer = await subscriber(h.sessions, "reportedstreamer26");
        const res = await testApp.request(
          "/streaming/reports",
          postForm(
            reporterCookie,
            { reported_user_id: streamer.actor.userId, reason: "   " },
            h.ip,
          ),
          h.bindings,
        );
        expect(res.status).toBe(422);
        const html = await res.text();
        expect(html).toContain('role="alert"');
        expect(html).toContain(streamer.actor.username);
        expect(await reportsFor(fixture.client, streamer.actor.userId)).toHaveLength(0);
      });

      it("reports against unknown streamers are 404", async () => {
        const h = await setup();
        const reporter = memberActor("reporter27");
        await seedUsers(fixture.client, [reporter]);
        const reporterCookie = await cookieFor(h.sessions, reporter);
        const res = await testApp.request(
          "/streaming/reports",
          postForm(
            reporterCookie,
            { reported_user_id: "100000000000099999", reason: "ghost case ab27" },
            h.ip,
          ),
          h.bindings,
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toMatch(/no streaming input|unknown streamer|not streaming/i);
      });

      it("the intake throttles at the member-write budget", async () => {
        const h = await setup();
        const reporter = memberActor("reporter28");
        await seedUsers(fixture.client, [reporter]);
        const reporterCookie = await cookieFor(h.sessions, reporter);
        const streamer = await subscriber(h.sessions, "reportedstreamer28");
        const fields = { reported_user_id: streamer.actor.userId, reason: "flood case ab28" };
        for (let i = 0; i < WRITE_THROTTLE_PER_MINUTE; i++) {
          const res = await testApp.request(
            "/streaming/reports",
            postForm(reporterCookie, fields, h.ip),
            h.bindings,
          );
          expect(res.status, `write ${i}`).toBe(303);
        }
        const limited = await testApp.request(
          "/streaming/reports",
          postForm(reporterCookie, fields, h.ip),
          h.bindings,
        );
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBeTruthy();
        expect(await limited.text()).toMatch(/rate.?limited|too many|slow/i);
      });

      it("links pages carry report links into the intake", async () => {
        const h = await setup();
        await requireTables(fixture.client, [
          { name: "member_links", owner: "link-in-bio slice (S1)" },
        ]);
        const streamer = await subscriber(h.sessions, "reportedstreamer29");
        await fixture.client`INSERT INTO member_links (user_id, links)
          VALUES (${streamer.actor.userId}, ${fixture.client.json([{ label: "Twitch", url: "https://twitch.tv/reportedstreamer29" }])})
          ON CONFLICT (user_id) DO UPDATE SET links = EXCLUDED.links`;
        const page = await testApp.request(
          `/members/${streamer.actor.userId}/links`,
          getPage(null, h.ip),
          h.bindings,
        );
        expect(page.status).toBe(200);
        const html = await page.text();
        const reports = reportAnchors(html);
        expect(reports.length).toBeGreaterThanOrEqual(1);
        for (const r of reports) {
          expect(r.href.startsWith("/"), `report href ${r.href} is origin-relative`).toBe(true);
          const target = await testApp.request(r.href, getPage(null, h.ip), h.bindings);
          expect(target.status, `report target ${r.href}`).not.toBe(404);
        }
        expect(reports.some((r) => r.href.startsWith("/streaming/reports/new"))).toBe(true);
      });

      it("live pages carry report links into the intake", async () => {
        const h = await setup();
        const streamer = await subscriber(h.sessions, "reportedstreamer30");
        const page = await testApp.request(
          `/members/${streamer.actor.userId}/live`,
          getPage(null, h.ip),
          h.bindings,
        );
        expect(page.status).toBe(200);
        const html = await page.text();
        const reports = reportAnchors(html);
        expect(reports.length).toBeGreaterThanOrEqual(1);
        for (const r of reports) {
          expect(r.href.startsWith("/"), `report href ${r.href} is origin-relative`).toBe(true);
          const target = await testApp.request(r.href, getPage(null, h.ip), h.bindings);
          expect(target.status, `report target ${r.href}`).not.toBe(404);
        }
        expect(reports.some((r) => r.href.startsWith("/streaming/reports/new"))).toBe(true);
      });
    });

    describe("kill-switch tables, live rows", () => {
      type ColumnRow = { column_name: string; data_type: string; column_default: string | null };

      async function columns(table: string): Promise<Map<string, ColumnRow>> {
        const rows = (await fixture.client`SELECT column_name, data_type, column_default
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ${table}`) as unknown as ColumnRow[];
        return new Map(rows.map((r) => [r.column_name, r]));
      }

      it("stream_reports carries reporter, reported, session, reason and status", async () => {
        await requireTables(fixture.client, [{ name: "stream_reports", owner: S7 }]);
        const byName = await columns("stream_reports");
        for (const col of [
          "id",
          "reporter_user_id",
          "reported_user_id",
          "session_id",
          "reason",
          "status",
          "created_at",
        ]) {
          expect(byName.has(col), col).toBe(true);
        }
        expect(byName.get("status")!.column_default).toContain("open");
      });

      it("stream_notifications carries user, kind, reason and appeal path", async () => {
        await requireTables(fixture.client, [{ name: "stream_notifications", owner: S7 }]);
        const byName = await columns("stream_notifications");
        for (const col of ["id", "user_id", "kind", "reason", "appeal_path", "created_at"]) {
          expect(byName.has(col), col).toBe(true);
        }
      });

      it("stream_settings is a keyed JSON store", async () => {
        await requireTables(fixture.client, [{ name: "stream_settings", owner: S7 }]);
        const byName = await columns("stream_settings");
        expect(byName.get("key")!.data_type).toBe("text");
        expect(byName.get("value")!.data_type).toBe("jsonb");
        await fixture.client`INSERT INTO stream_settings (key, value) VALUES ('global', ${fixture.client.json({ enabled: true, disabledAt: null, disabledReason: null })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
        const setting = await globalSetting(fixture.client);
        expect(setting?.value).toEqual({ enabled: true, disabledAt: null, disabledReason: null });
      });

      it("live inputs carry the forced-rotation flag defaulting to false", async () => {
        await requireTables(fixture.client, [{ name: "stream_live_inputs", owner: S3 }]);
        const byName = await columns("stream_live_inputs");
        expect(byName.has("must_rotate_key")).toBe(true);
        expect(byName.get("must_rotate_key")!.data_type).toBe("boolean");
        expect(byName.get("must_rotate_key")!.column_default).toContain("false");
      });
    });
  },
);
