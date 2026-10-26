// Acceptance: moderator dashboard surfaces drafts awaiting review.
//
// Failing-first handoff for the builder. The dashboard's Events card is static;
// moderators cannot tell whether drafts await review without opening the
// inventory. The builder adds ONE bounded, deadline-owned, non-member
// draft-existence read (LIMIT 1 / EXISTS — never COUNT, never a row/roster
// projection) shared by the Hono route and the Kit load, plus a truthful
// existence signal with the two native next actions: the existing
// draft-filtered inventory and the existing create-draft form.
//
// Contract this file pins (builder implements exactly this):
// - Tri-state prop/data `draftsAwaitingReview: boolean | undefined`
//   (true = drafts await, false = none await, undefined = omit the signal).
// - Signal section `data-testid="drafts-awaiting-review"` containing a review
//   link to /admin/events with status=draft and a create link to
//   /admin/events/new. No numeric draft count in the signal (existence, not a
//   dashboard count).
// - Degraded/absent/cancelled reads omit ONLY the signal and never claim zero;
//   a classified outage keeps the existing shared 503 posture like the funnel
//   and zero-search widgets (omitting on outage would invent a new failure
//   policy for this widget).
// - No member identity fields, no new routes, no-store + guard + audit
//   unchanged, existing widgets and diagnostics copy untouched.
//
// Fixture safety: hermetic except the final live block, which runs against the
// guarded disposable test database in a throwaway schema (skipped when
// DATABASE_URL is unset) and never touches production or staging. The offline
// route tests drive the REAL adminApp handler, guard, member-read boundary and
// JSX renderer with a drizzle.mock ADMIN_DB that captures SQL; the renderer
// tests drive the REAL Hono component and the REAL compiled Kit SSR output.
// The two source-sharing assertions are supplemental: behavioral parity plus
// SQL capture is the proof.
//
// Expected results on the base commit (no implementation): 22 failed,
// 9 passed, 2 skipped (live DB needs DATABASE_URL).
// - FAIL: every present/absent signal test (no signal renders), the parity
//   and no-identity tests, every SQL shape test ("draft read was attempted" /
//   "one bounded read"), the hanging bound, error/cancellation
//   omission-with-attempt, draft-outage 503, all five decision-contract draft
//   tests (outage verdict, widget ownership, healthy passthrough), and the
//   source-sharing check.
// - PASS (unchanged controls): renderer degraded-omission pair (vacuous on
//   base: nothing renders, so omission holds — they pin the builder's
//   degrade-to-omit + widget-preservation behavior), no-db omission,
//   funnel-outage 503 with draft rows present, guest bounce, non-moderator
//   403, no-store headers, no new routes, existing two-argument decision
//   shape, empty-copy preservation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/postgres-js";
import { serializeSigned } from "hono/utils/cookie";
import type { FC } from "hono/jsx";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { AdminDashboard } from "../src/admin/pages";
import { resolveDashboardWidgets } from "../src/admin/kit-dashboard";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import testApp from "./app";
import { cookieFor, env as memberEnv, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { events } from "../src/db/admin-schema";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (p: string): string => readFileSync(join(root, p), "utf8");

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// The acceptance contract names. The builder implements this prop/data key and
// testid on both renderers; behavioral assertions below do the rest.
const DRAFT_PROP = "draftsAwaitingReview";
const DRAFT_SIGNAL_TESTID = "drafts-awaiting-review";
const CREATE_DRAFT_HREF = "/admin/events/new";
const BRANDED_OUTAGE_MARK = "We will be right back";

const actor = { id: "fixture-mod", username: "Fixture moderator" };
const funnel = { added: 7, rate_limited: 2 };
const zeroSearches = [
  { query: "fixture chess", searches: 3, lastSearchedAt: new Date("2026-10-20T12:00:00.000Z") },
];

type DraftState = "present" | "absent" | "degraded";
const draftValue = (state: DraftState): boolean | undefined =>
  state === "present" ? true : state === "absent" ? false : undefined;

type Element = { attrs: string; body: string };
// Test-only text extraction for assertions (no HTML sink): walk the markup
// token by token instead of a `<...>` regex replace so the helper does not
// read as an HTML sanitizer. Mirrors the twin-parity walker.
function text(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] === "<") {
      const close = html.indexOf(">", index);
      if (close === -1) break;
      index = close + 1;
      continue;
    }
    const next = html.indexOf("<", index);
    out += html.slice(index, next === -1 ? html.length : next);
    index = next === -1 ? html.length : next;
  }
  return out.replace(/\s+/g, " ").trim();
}
const attr = (element: Element, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(element.attrs)?.[1];
const elements = (html: string, tag: string): Element[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => ({
    attrs: match[1]!,
    body: match[2]!,
  }));
const anchors = (html: string): { href: string | undefined; text: string }[] =>
  elements(html, "a").map((link) => ({ href: attr(link, "href"), text: text(link.body) }));

function byTestId(html: string, testid: string): Element {
  const matches = [
    ...html.matchAll(
      new RegExp(
        `<([a-z][\\w-]*)\\b([^>]*\\bdata-testid="${testid}"[^>]*)>([\\s\\S]*?)</\\1>`,
        "g",
      ),
    ),
  ];
  expect(matches, `exactly one rendered ${testid}`).toHaveLength(1);
  return { attrs: matches[0]![2]!, body: matches[0]![3]! };
}

const isDraftReviewHref = (href: string | undefined): boolean => {
  if (!href?.startsWith("/admin/events?")) return false;
  return new URL(href, "https://admin.example.test").searchParams.get("status") === "draft";
};

// ---------------------------------------------------------------------------
// Real twin renderers: the Hono component plus the real compiled Kit SSR page.
// ---------------------------------------------------------------------------
type RenderKit = (data: Record<string, unknown>) => string;
let renderKit: RenderKit;
let scratch = "";

beforeAll(async () => {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
  };
  scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "dashboard-drafts-ssr-"),
  );
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/+page.svelte"))};
export function renderKit(data) { return render(Page, { props: { data } }).body; }
`,
  );
  const outfile = join(scratch, "bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    tsconfigRaw: {},
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "dashboard-drafts-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const { js } = compile(readFileSync(args.path, "utf8"), {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as { renderKit: RenderKit };
  renderKit = mod.renderKit;
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// The acceptance prop does not exist on the base component: widen the props
// once so a missing signal fails as a failed assertion (missing behavior),
// never as a type error (broken setup).
const DashboardWithDrafts = AdminDashboard as unknown as FC<Record<string, unknown>>;

const renderers = [
  {
    name: "Hono",
    render(state: DraftState): string {
      return String(
        jsx(DashboardWithDrafts, {
          actor,
          funnel,
          zeroSearches,
          [DRAFT_PROP]: draftValue(state),
        }),
      );
    },
  },
  {
    name: "Kit",
    render(state: DraftState): string {
      return renderKit({
        actor,
        retentionDays: 90,
        funnel,
        zeroSearches: zeroSearches.map((row) => ({
          ...row,
          lastSearchedAt: row.lastSearchedAt.toISOString(),
        })),
        [DRAFT_PROP]: draftValue(state),
      });
    },
  },
];

for (const renderer of renderers) {
  describe(`${renderer.name} dashboard draft signal`, () => {
    it("present: shows a truthful existence signal with review + create next actions", () => {
      const signal = byTestId(renderer.render("present"), DRAFT_SIGNAL_TESTID);
      const copy = text(signal.body);
      expect(copy).toMatch(/drafts?\s+await/i);
      expect(copy, "a present signal never claims zero").not.toMatch(/no\s+drafts?/i);
      expect(copy, "existence signal, not a count dashboard: no quantified drafts").not.toMatch(
        /\b\d+\s+drafts?\b/i,
      );
      const links = anchors(signal.body);
      const review = links.filter((link) => isDraftReviewHref(link.href));
      expect(review, "one native link to the draft-filtered inventory").toHaveLength(1);
      const create = links.filter((link) => link.href === CREATE_DRAFT_HREF);
      expect(create, "the existing native create-draft shortcut").toHaveLength(1);
    });

    it("absent: a successful empty read alone may say no drafts await review", () => {
      const signal = byTestId(renderer.render("absent"), DRAFT_SIGNAL_TESTID);
      const copy = text(signal.body);
      expect(copy).toMatch(/no\s+drafts?\s+await/i);
      const links = anchors(signal.body);
      expect(
        links.filter((link) => isDraftReviewHref(link.href)),
        "the draft-filtered inventory stays reachable when empty",
      ).toHaveLength(1);
      expect(
        links.filter((link) => link.href === CREATE_DRAFT_HREF),
        "the create-draft shortcut stays reachable when empty",
      ).toHaveLength(1);
    });

    it("degraded: omits only the signal, never claims zero, widgets stay", () => {
      const html = renderer.render("degraded");
      expect(html).not.toContain(`data-testid="${DRAFT_SIGNAL_TESTID}"`);
      expect(html, "a degraded read never claims zero").not.toMatch(/no\s+drafts?/i);
      expect(
        anchors(html).filter((link) => isDraftReviewHref(link.href)),
        "no draft-review link without a successful read",
      ).toHaveLength(0);
      // Only the new signal goes: existing analytics, cards and actor stay.
      expect(html).toContain('data-testid="join-funnel"');
      expect(html).toContain('data-testid="top-zero-searches"');
      expect(html).toContain('data-testid="admin-actor"');
      const cardHrefs = elements(html, "li")
        .filter((item) => attr(item, "class")?.split(/\s+/).includes("card"))
        .flatMap((item) => anchors(item.body).map((link) => link.href));
      expect(cardHrefs).toEqual(
        expect.arrayContaining([
          "/admin/events",
          "/admin/featured",
          "/admin/activity-log",
          "/admin/join-attempts",
        ]),
      );
    });

    it("signal carries no member identity beyond the signed-in actor", () => {
      for (const state of ["present", "absent"] as const) {
        const signal = byTestId(renderer.render(state), DRAFT_SIGNAL_TESTID);
        expect(text(signal.body)).not.toMatch(/\d{10,25}/);
      }
    });
  });
}

describe("dashboard draft signal Hono/Kit parity", () => {
  it("both renderers offer the same native next-action targets", () => {
    const targets = (html: string) =>
      anchors(byTestId(html, DRAFT_SIGNAL_TESTID).body)
        .map((link) => link.href)
        .filter((href): href is string => href !== undefined)
        .sort();
    for (const state of ["present", "absent"] as const) {
      expect(targets(renderers[1]!.render(state))).toEqual(targets(renderers[0]!.render(state)));
      expect(targets(renderers[0]!.render(state))).toContain(CREATE_DRAFT_HREF);
    }
  });
});

// ---------------------------------------------------------------------------
// Route-level read contract: real handler + guard + boundary, SQL-capturing DB.
// ---------------------------------------------------------------------------
async function moderatorCookie(store: ReturnType<typeof createMemorySessionStore>) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000111",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const s = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return s.split(";")[0]!;
}

type ExistenceFixture = unknown[] | Error | "hang";
// drizzle.mock with SQL capture: only returned rows are fixtures; builders,
// dialect and execution metadata stay real. Unknown statements throw so a
// widened dashboard read cannot hide.
function captureDb(existence: ExistenceFixture, funnelN = 7, funnelError?: Error) {
  const statements: string[] = [];
  const db = drizzle.mock() as unknown as Db;
  const session = (
    db as unknown as {
      session: {
        prepareQuery: (query: { sql: string }) => unknown;
        transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
      };
    }
  ).session;
  session.prepareQuery = (query) => ({
    setToken() {
      return this;
    },
    execute: async () => {
      statements.push(query.sql);
      if (query.sql.includes('from "events"')) {
        if (existence === "hang") return new Promise<never>(() => {});
        if (existence instanceof Error) throw existence;
        return existence;
      }
      if (query.sql.includes('from "join_attempts"')) {
        if (funnelError) throw funnelError;
        return [{ outcome: "added", n: funnelN }];
      }
      if (query.sql.includes('from "event_search_logs"')) return [];
      if (query.sql.startsWith("select set_config(")) return [];
      throw new Error(`Dashboard draft fixture has no rows for: ${query.sql.slice(0, 160)}`);
    },
  });
  session.transaction = async (work) => work(db);
  return { db, statements };
}

const existenceStatements = (statements: string[]) =>
  statements.filter((sql) => sql.includes('from "events"'));

function expectBoundedExistenceShape(statements: string[]) {
  const reads = existenceStatements(statements);
  expect(reads, "exactly one bounded draft-existence read against events").toHaveLength(1);
  const sql = reads[0]!;
  expect(sql).toMatch(/draft/);
  expect(sql, "LIMIT 1 or EXISTS bounds the read").toMatch(/limit\s+1\b|exists/i);
  expect(sql, "never COUNT").not.toMatch(/count\s*\(/i);
  expect(sql, "never a member/roster read").not.toMatch(
    /rsvps|users|profiles|join_attempts|member_data|username|user_id|discord_id/i,
  );
  const projection = sql.slice(0, sql.toLowerCase().indexOf("from"));
  expect(projection, "never a row/content projection").not.toMatch(
    /title|description|game|location|organizer|capacity|rsvp/i,
  );
  // Each optional widget transacts once and installs its local timeouts; the
  // draft read is the third install. Without its own install this stays at two.
  const installs = statements.filter((s) => s.toLowerCase().includes("set_config"));
  expect(installs.length, "the draft read installs its own local timeouts").toBeGreaterThanOrEqual(
    3,
  );
  const firstInstall = statements.findIndex((s) => s.toLowerCase().includes("set_config"));
  const eventsSelect = statements.findIndex((s) => s.includes('from "events"'));
  expect(firstInstall).toBeGreaterThanOrEqual(0);
  expect(firstInstall).toBeLessThan(eventsSelect);
}

describe("dashboard draft-existence read (SQL capture)", () => {
  it("present: one bounded existence read, truthful signal, both next actions", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const { db, statements } = captureDb([{ one: 1 }]);
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    expect(res.status).toBe(200);
    expectBoundedExistenceShape(statements);
    const html = await res.text();
    const signal = byTestId(html, DRAFT_SIGNAL_TESTID);
    expect(text(signal.body)).toMatch(/drafts?\s+await/i);
    expect(text(signal.body)).not.toMatch(/no\s+drafts?/i);
    const links = anchors(signal.body);
    expect(links.filter((link) => isDraftReviewHref(link.href))).toHaveLength(1);
    expect(links.filter((link) => link.href === CREATE_DRAFT_HREF)).toHaveLength(1);
    expect(html).toContain('data-testid="join-funnel"');
  });

  it("absent: an empty existence read says no drafts await review", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const { db, statements } = captureDb([]);
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    expect(res.status).toBe(200);
    expectBoundedExistenceShape(statements);
    const signal = byTestId(await res.text(), DRAFT_SIGNAL_TESTID);
    expect(text(signal.body)).toMatch(/no\s+drafts?\s+await/i);
  });
});

describe("dashboard draft read degradation (paired fixtures)", () => {
  it("ordinary failure omits only the signal and never claims zero", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const { db, statements } = captureDb(new TypeError("private bug"));
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    expect(res.status).toBe(200);
    expect(
      existenceStatements(statements),
      "the draft read was attempted (missing behavior, not setup)",
    ).toHaveLength(1);
    const html = await res.text();
    expect(html).not.toContain(`data-testid="${DRAFT_SIGNAL_TESTID}"`);
    expect(html).not.toMatch(/no\s+drafts?/i);
    expect(html).toContain('data-testid="join-funnel"');
    expect(html).toContain('data-testid="top-zero-searches"');
  });

  it.each([
    { code: "55P03", depth: 1 },
    { code: "55P03", depth: 2 },
    { code: "57014", depth: 1 },
    { code: "57014", depth: 2 },
  ])(
    "wrapped $code cancellation at depth $depth omits only the signal",
    async ({ code, depth }) => {
      let error: Error = Object.assign(new Error("statement timeout"), {
        name: "PostgresError",
        code,
      });
      for (let i = 0; i < depth; i++) error = new Error("Failed query", { cause: error });
      const store = createMemorySessionStore();
      const cookie = await moderatorCookie(store);
      const { db, statements } = captureDb(error);
      const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
        ...env,
        ADMIN_DB: db,
      } as Env);
      expect(res.status).toBe(200);
      expect(
        existenceStatements(statements),
        "the draft read was attempted (missing behavior, not setup)",
      ).toHaveLength(1);
      const html = await res.text();
      expect(html).not.toContain(`data-testid="${DRAFT_SIGNAL_TESTID}"`);
      expect(html).not.toMatch(/no\s+drafts?/i);
      expect(html).toContain('data-testid="join-funnel"');
    },
  );

  it("a hanging draft read never holds the dashboard past a bounded wait", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const { db, statements } = captureDb("hang");
    const pending = adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    // Test-side detector only, not the production deadline: the builder's own
    // deadline (same family as the funnel's) settles far inside this.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000));
    const res = await Promise.race([pending, timeout]);
    expect(res, "dashboard must answer bounded while the draft read hangs").not.toBeNull();
    expect(res!.status).toBe(200);
    expect(
      existenceStatements(statements),
      "the draft read was attempted (missing behavior, not setup)",
    ).toHaveLength(1);
    const html = await res!.text();
    expect(html).not.toContain(`data-testid="${DRAFT_SIGNAL_TESTID}"`);
    expect(html).not.toMatch(/no\s+drafts?/i);
    expect(html, "the healthy funnel still renders under a hung draft read").toContain(
      'data-testid="join-funnel"',
    );
  });

  it("a classified draft outage keeps the shared 503 posture, like the other widgets", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const outage = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const { db } = captureDb(outage);
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain(BRANDED_OUTAGE_MARK);
    expect(body).not.toMatch(/connection refused|ECONNREFUSED/);
  });
});

describe("dashboard draft controls (unchanged behavior)", () => {
  it("no database: every optional widget omits, cards stay, no zero claim", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      DATABASE_URL: undefined,
    } as Env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(`data-testid="${DRAFT_SIGNAL_TESTID}"`);
    expect(html).not.toMatch(/no\s+drafts?/i);
    expect(html).not.toContain('data-testid="join-funnel"');
    for (const href of ["/admin/events", "/admin/featured", "/admin/activity-log"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("a funnel outage still 503s when draft rows exist", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    // Fail only the funnel aggregate: the draft read still succeeds, and must
    // not mask the classified outage.
    const outage = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const { db } = captureDb([{ one: 1 }], 7, outage);
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(BRANDED_OUTAGE_MARK);
  });

  it("guests bounce to OAuth and non-moderators 403, drafts or not", async () => {
    const store = createMemorySessionStore();
    const { db } = captureDb([{ one: 1 }]);
    const bindings = { ...env, ADMIN_DB: db } as Env;
    const guest = await adminApp({ sessionStore: store }).request("/", {}, bindings);
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toContain("/auth/discord");
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000222",
      username: "pleb",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const memberCookie = (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const forbidden = await adminApp({ sessionStore: store }).request(
      "/",
      { headers: { cookie: memberCookie } },
      bindings,
    );
    expect(forbidden.status).toBe(403);
  });

  it("dashboard answers private, no-store", async () => {
    const store = createMemorySessionStore();
    const cookie = await moderatorCookie(store);
    const { db } = captureDb([{ one: 1 }]);
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: db,
    } as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("adds no routes: the admin inventory stays exactly the shipped set", () => {
    const paths = new Set(
      adminApp({ sessionStore: createMemorySessionStore() }).routes.map(
        (r) => `${r.method} ${r.path}`,
      ),
    );
    const known = new Set([
      "GET /queue/source-evidence/:id",
      "POST /queue/source-evidence/:id",
      "PUT /queue/source-evidence/:id",
      "PATCH /queue/source-evidence/:id",
      "DELETE /queue/source-evidence/:id",
      "OPTIONS /queue/source-evidence/:id",
      "ALL /queue/*",
      "ALL /*",
      "GET /queue/failed/:id/preview",
      "POST /queue/failed/:id/redispatch",
      "GET /events/create",
      "GET /events/:key/edit",
      "GET /featured-contents",
      "GET /featured-contents/create",
      "GET /featured-contents/:id/edit",
      "GET /",
      "GET /join-attempts",
      "GET /join-attempts/:id",
      "GET /activity-log",
      "GET /events",
      "GET /events/new",
      "POST /events",
      "GET /events/:key",
      "POST /events/:key",
      "POST /events/:key/publish",
      "POST /events/:key/cancel",
      "POST /events/:key/rsvp-pause",
      "POST /events/:key/rsvp-reopen",
      "POST /events/:key/duplicate",
      "GET /featured",
      "GET /featured/new",
      "POST /featured",
      "GET /featured/:id",
      "POST /featured/:id",
      "POST /featured/:id/delete",
    ]);
    for (const route of paths) {
      expect([...known], `no new admin route for the draft signal (saw ${route})`).toContain(route);
    }
  });

  it("existing widget empty copy is untouched", () => {
    const honoEmpty = String(
      jsx(DashboardWithDrafts, { actor, funnel: {}, zeroSearches: [], [DRAFT_PROP]: undefined }),
    );
    expect(text(byTestId(honoEmpty, "join-funnel-empty").body)).toBe(
      "No join attempts in the window.",
    );
    expect(text(byTestId(honoEmpty, "top-zero-searches-empty").body)).toBe("No missed searches.");
  });
});

// ---------------------------------------------------------------------------
// Shared decision contract across Hono and Kit.
// ---------------------------------------------------------------------------
describe("dashboard draft decision contract", () => {
  const refused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  const funnelValue = { added: 3 };
  const zeroValue = [{ query: "zzz", searches: 2, lastSearchedAt: "2026-10-01T00:00:00.000Z" }];
  // The builder extends the resolver with the draft widget; calling with the
  // third outcome against the base two-widget resolver must fail by shape
  // (missing behavior), never by import.
  const resolve3 = resolveDashboardWidgets as unknown as (
    funnel: PromiseSettledResult<unknown>,
    zero: PromiseSettledResult<unknown>,
    drafts?: PromiseSettledResult<boolean | undefined>,
  ) => Record<string, unknown>;

  it("a refused draft read is an outage, like the other widgets", () => {
    expect(
      resolve3(
        { status: "fulfilled", value: funnelValue },
        { status: "fulfilled", value: zeroValue },
        { status: "rejected", reason: refused() },
      ),
    ).toEqual({ outage: true });
  });

  it("an ordinary draft failure degrades to an omitted signal", () => {
    const result = resolve3(
      { status: "fulfilled", value: funnelValue },
      { status: "fulfilled", value: zeroValue },
      { status: "rejected", reason: new Error("syntax error at end of input") },
    );
    // toEqual ignores undefined-valued keys, so ownership needs its own pin:
    // the resolver must name the draft widget even when it degrades.
    expect(result, "the resolver owns the draft widget").toHaveProperty(DRAFT_PROP);
    expect(result).toEqual({
      outage: false,
      funnel: funnelValue,
      zeroSearches: zeroValue,
      [DRAFT_PROP]: undefined,
    });
  });

  it("a draft cancellation degrades to an omitted signal", () => {
    const cancellation = Object.assign(new Error("statement timeout"), {
      name: "PostgresError",
      code: "57014",
    });
    const result = resolve3(
      { status: "fulfilled", value: funnelValue },
      { status: "fulfilled", value: zeroValue },
      { status: "rejected", reason: cancellation },
    );
    expect(result, "the resolver owns the draft widget").toHaveProperty(DRAFT_PROP);
    expect(result).toEqual({
      outage: false,
      funnel: funnelValue,
      zeroSearches: zeroValue,
      [DRAFT_PROP]: undefined,
    });
  });

  it.each([true, false])("a healthy draft read passes through: %s", (value) => {
    expect(
      resolve3(
        { status: "fulfilled", value: funnelValue },
        { status: "fulfilled", value: zeroValue },
        { status: "fulfilled", value },
      ),
    ).toEqual({
      outage: false,
      funnel: funnelValue,
      zeroSearches: zeroValue,
      [DRAFT_PROP]: value,
    });
  });

  it("control: the existing two-widget shape is unchanged", () => {
    expect(
      resolveDashboardWidgets(
        { status: "fulfilled", value: funnelValue },
        { status: "fulfilled", value: zeroValue },
      ),
    ).toEqual({ outage: false, funnel: funnelValue, zeroSearches: zeroValue });
  });

  it("supplemental: Hono and Kit reference one shared draft identifier", () => {
    // Behavioral parity plus SQL capture is the proof; this only guards the
    // "shared read" wiring from drifting into two private implementations.
    const candidates = [
      "draftsAwaitingReview",
      "hasDraftsAwaitingReview",
      "draftExistence",
      "hasDrafts",
      "draftReviewSignal",
    ];
    const hono = readSource("src/admin/routes.tsx");
    const kit =
      readSource("web/src/routes/admin/+page.server.ts") + readSource("src/admin/kit-dashboard.ts");
    const shared = candidates.filter((id) => hono.includes(id) && kit.includes(id));
    expect(shared, "one draft-existence identifier shared by Hono and Kit").not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Live truthfulness against the disposable test database (throwaway schema).
// ---------------------------------------------------------------------------
const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("dashboard drafts (test database)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const sessionStore = createMemorySessionStore();
  let cookie = "";
  let eventKeySeq = 0;
  const liveEnv = () =>
    ({ ...memberEnv, ADMIN_DB: db, SESSION_STORE: sessionStore }) as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(raw!, { max: 5 });
    db = fixture.db;
    cookie = await cookieFor(sessionStore, MODERATOR);
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  const seedEvent = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(events)
      .values({
        eventKey: `01J${String(++eventKeySeq).padStart(23, "0")}`,
        title: "Drafts signal night",
        game: "Chess",
        description: "Boards out",
        startsAt: new Date("2099-11-04T20:00:00.000Z"),
        endsAt: new Date("2099-11-04T22:00:00.000Z"),
        timezone: "Europe/London",
        location: "Voice",
        capacity: 8,
        status: "draft",
        ...over,
      })
      .returning();
    return row!;
  };

  it("a draft among published and cancelled rows shows the present signal", async () => {
    await fixture.reset();
    await seedEvent({ title: "Zxq Live Draft", status: "draft" });
    await seedEvent({ title: "Zxq Live Published", status: "published" });
    await seedEvent({ title: "Zxq Live Cancelled", status: "cancelled" });
    const res = await testApp.request("/admin", { headers: { cookie } }, liveEnv());
    expect(res.status).toBe(200);
    const signal = byTestId(await res.text(), DRAFT_SIGNAL_TESTID);
    expect(text(signal.body)).toMatch(/drafts?\s+await/i);
    expect(text(signal.body)).not.toMatch(/no\s+drafts?/i);
  });

  it("published-only rows show the truthful absent signal", async () => {
    await fixture.reset();
    await seedEvent({ title: "Zxq Live Published Only", status: "published" });
    const res = await testApp.request("/admin", { headers: { cookie } }, liveEnv());
    expect(res.status).toBe(200);
    const signal = byTestId(await res.text(), DRAFT_SIGNAL_TESTID);
    expect(text(signal.body)).toMatch(/no\s+drafts?\s+await/i);
  });
});
