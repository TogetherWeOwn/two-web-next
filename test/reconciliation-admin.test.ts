// route-inventory: GET /admin/reconciliation
// route-inventory: GET /admin/reconciliation/:key
// route-inventory: POST /admin/reconciliation/:key/resolve
// Reconciliation operator surface pins (contract v2 §7.4/§11).
//
// Moderator/admin-only queue over stuck keyed intents: list and detail are
// reads, only the resolve stamp writes — audited first, throttled, bounded.
// Guests redirect, members forbid, and no route ever re-sends under a fresh
// key. DB-free: injected store + audit doubles, in-memory sessions.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { ReconciliationStore, StuckIntentRecord } from "../src/jobs/reconciliation";
import { stuckIntent } from "../src/jobs/reconciliation";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const KEY = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_KEY = "99999999-9999-4999-8999-999999999999";

const NOW = new Date("2026-10-01T12:00:00Z");

function record(over: Partial<StuckIntentRecord> = {}): StuckIntentRecord {
  return {
    ...stuckIntent({
      idempotencyKey: KEY,
      verb: "announcement.post",
      subject: "channel-synthetic",
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      lastRequestId: "req-1",
      attempts: 3,
    }),
    firstSeenAt: NOW,
    lastAttemptAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    ...over,
  };
}

/** In-memory operator surface double. */
function memStore(seed: StuckIntentRecord[] = []) {
  const rows = new Map(seed.map((r) => [r.idempotencyKey, r]));
  const store: ReconciliationStore = {
    recordStuck: async (intent) => {
      const row: StuckIntentRecord = {
        ...intent,
        firstSeenAt: NOW,
        lastAttemptAt: NOW,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };
      rows.set(intent.idempotencyKey, row);
      return row;
    },
    listOpen: async () => [...rows.values()].filter((r) => !r.resolvedAt),
    listResolved: async () => [...rows.values()].filter((r) => !!r.resolvedAt),
    getStuck: async (key) => rows.get(key) ?? null,
    resolveStuck: async (key, resolution) => {
      const row = rows.get(key);
      if (!row || row.resolvedAt) return null;
      const resolved = {
        ...row,
        resolvedAt: NOW,
        resolvedBy: resolution.by,
        resolution: resolution.note,
      };
      rows.set(key, resolved);
      return resolved;
    },
  };
  return { store, rows };
}

const dbTouched = vi.fn(() => {
  throw new Error("reconciliation admin test must not query SQL");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;

async function mounted(
  store: ReconciliationStore,
  audit: (env: Env, actorId: string, key: string, note: string) => Promise<void>,
) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MODERATOR);
  const memberCookie = await cookieFor(sessions, MEMBER);
  const app = new Hono()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: sessions, db }));
  const bindings = { ...env, ADMIN_DB: db, RECONCILIATION_DEPS: { store, audit } };
  return { app, cookie, memberCookie, bindings };
}

function post(cookie: string, values: Record<string, string>) {
  return {
    method: "POST",
    headers: {
      cookie,
      origin: env.APP_URL,
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values).toString(),
  };
}

const auditOk = async () => {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconciliation guard pins", () => {
  it("redirects guests and forbids members on every route, before any store read", async () => {
    const reads = vi.fn(async () => []);
    const store: ReconciliationStore = {
      ...memStore().store,
      listOpen: reads,
      listResolved: reads,
      getStuck: reads as unknown as ReconciliationStore["getStuck"],
    };
    const sessions = createMemorySessionStore();
    const memberCookie = await cookieFor(sessions, MEMBER);
    const app = adminApp({ sessionStore: sessions, db });
    const bindings = { ...env, ADMIN_DB: db, RECONCILIATION_DEPS: { store, audit: auditOk } };
    expect((await app.request("/admin/reconciliation", {}, bindings)).status).toBe(302);
    for (const path of [
      "/reconciliation",
      `/reconciliation/${KEY}`,
      `/reconciliation/${KEY}/resolve`,
    ]) {
      const res = await app.request(
        path,
        path.endsWith("/resolve")
          ? { method: "POST", headers: { cookie: memberCookie, origin: env.APP_URL } }
          : { headers: { cookie: memberCookie } },
        bindings,
      );
      expect(res.status, path).toBe(403);
    }
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("reconciliation list and detail", () => {
  it("lists open and resolved rows with honest copy, never a delivery promise", async () => {
    const resolved = record({
      idempotencyKey: UNKNOWN_KEY,
      resolvedAt: NOW,
      resolvedBy: "mod-1",
      resolution: "checked Discord; already posted",
    });
    const { app, cookie, bindings } = await mounted(memStore([record(), resolved]).store, auditOk);
    const res = await app.request("/admin/reconciliation", { headers: { cookie } }, bindings);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Needs a human (1)");
    expect(html).toContain("Recently resolved (1)");
    expect(html).toContain("announcement.post");
    expect(html).toContain("channel-synthetic");
    expect(html).toContain("needs_reconciliation");
    // Honest in-between state: check by hand, never re-send, never delivered.
    expect(html).toContain("Check Discord by hand");
    expect(html).toContain("Never re-send from here");
    expect(html).not.toMatch(/delivered|successfully posted|sent to Discord/i);
    expect(html).toContain(`reconciliation-open-table`);
  });

  it("renders the empty state when nothing is stuck", async () => {
    const { app, cookie, bindings } = await mounted(memStore().store, auditOk);
    const html = await (
      await app.request("/admin/reconciliation", { headers: { cookie } }, bindings)
    ).text();
    expect(html).toContain("Nothing stuck.");
  });

  it("details the scalar facts plus the resolve form for an open row", async () => {
    const { app, cookie, bindings } = await mounted(memStore([record()]).store, auditOk);
    const res = await app.request(
      `/admin/reconciliation/${KEY}`,
      { headers: { cookie } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(KEY);
    expect(html).toContain("channel-synthetic");
    expect(html).toContain("needs_reconciliation");
    expect(html).toContain('class="notice"');
    expect(html).toContain("Discord may or may not carry this change.");
    expect(html).toContain('data-testid="reconciliation-resolve"');
    expect(html).toContain(`/admin/reconciliation/${KEY}/resolve`);
  });

  it("shows the resolution and no form for a resolved row", async () => {
    const resolved = record({
      resolvedAt: NOW,
      resolvedBy: "mod-1",
      resolution: "re-posted by hand",
    });
    const { app, cookie, bindings } = await mounted(memStore([resolved]).store, auditOk);
    const html = await (
      await app.request(`/admin/reconciliation/${KEY}`, { headers: { cookie } }, bindings)
    ).text();
    expect(html).toContain("re-posted by hand");
    expect(html).toContain("Resolution note");
    expect(html).toContain("Resolved by");
    expect(html).not.toContain('class="notice"');
    expect(html).not.toContain('data-testid="reconciliation-resolve"');
  });

  it("404s on a non-UUID key and on an unknown UUID", async () => {
    const { app, cookie, bindings } = await mounted(memStore([record()]).store, auditOk);
    for (const path of [
      "/admin/reconciliation/not-a-uuid",
      `/admin/reconciliation/${UNKNOWN_KEY}`,
    ]) {
      const res = await app.request(path, { headers: { cookie } }, bindings);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("Stuck intent not found");
    }
  });
});

describe("reconciliation resolve", () => {
  it("stamps the row on a valid note: audit first, then 303 to the detail", async () => {
    const audits: { actorId: string; key: string; note: string }[] = [];
    const { store } = memStore([record()]);
    const { app, cookie, bindings } = await mounted(store, async (_e, actorId, key, note) => {
      audits.push({ actorId, key, note });
    });
    const res = await app.request(
      `/admin/reconciliation/${KEY}/resolve`,
      post(cookie, { resolution: "Checked Discord; the post landed. No action needed." }),
      bindings,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(`/admin/reconciliation/${KEY}`);
    // The receipt precedes the stamp: actor, key and note all recorded.
    expect(audits).toEqual([
      {
        actorId: MODERATOR.userId,
        key: KEY,
        note: "Checked Discord; the post landed. No action needed.",
      },
    ]);
    expect((await store.getStuck(KEY))?.resolvedBy).toBe(MODERATOR.userId);
  });

  it("422s a blank or over-long note with a field error and no stamp", async () => {
    const audits: unknown[] = [];
    const { store } = memStore([record()]);
    const { app, cookie, bindings } = await mounted(store, async () => void audits.push(1));
    for (const resolution of ["", "   ", "x".repeat(501)]) {
      const res = await app.request(
        `/admin/reconciliation/${KEY}/resolve`,
        post(cookie, { resolution }),
        bindings,
      );
      expect(res.status, JSON.stringify(resolution).slice(0, 20)).toBe(422);
      const html = await res.text();
      expect(html).toContain('data-testid="error-resolution"');
      expect(html).toContain("500 characters or fewer");
    }
    expect(audits).toEqual([]);
    expect((await store.getStuck(KEY))?.resolvedAt).toBeNull();
  });

  it("redirects an already-resolved row without auditing again", async () => {
    const audits: unknown[] = [];
    const resolved = record({ resolvedAt: NOW, resolvedBy: "mod-1", resolution: "done" });
    const { app, cookie, bindings } = await mounted(
      memStore([resolved]).store,
      async () => void audits.push(1),
    );
    const res = await app.request(
      `/admin/reconciliation/${KEY}/resolve`,
      post(cookie, { resolution: "another note" }),
      bindings,
    );
    expect(res.status).toBe(303);
    expect(audits).toEqual([]);
  });

  it("refuses the resolve when the audit trail is unwritable, stamping nothing", async () => {
    const { store } = memStore([record()]);
    const { app, cookie, bindings } = await mounted(store, async () => {
      throw new Error("trail down");
    });
    const res = await app.request(
      `/admin/reconciliation/${KEY}/resolve`,
      post(cookie, { resolution: "checked Discord" }),
      bindings,
    );
    expect(res.status).toBe(503);
    expect((await store.getStuck(KEY))?.resolvedAt).toBeNull();
  });

  it("404s a resolve for an unknown key without auditing", async () => {
    const audits: unknown[] = [];
    const { app, cookie, bindings } = await mounted(
      memStore([record()]).store,
      async () => void audits.push(1),
    );
    const res = await app.request(
      `/admin/reconciliation/${UNKNOWN_KEY}/resolve`,
      post(cookie, { resolution: "checked Discord" }),
      bindings,
    );
    expect(res.status).toBe(404);
    expect(audits).toEqual([]);
  });
});
