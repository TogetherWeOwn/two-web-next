// Independent acceptance contract: events copy a portable Discord time summary.
// Test-author owned: the Builder consumes this file without editing it;
// corrections return to the Test Author. No database, account, or network.
// Run: npx vitest run test/event-discord-times-acceptance.test.ts
// Fixture-only RED: this run executes real Hono rendering and the real Kit
// model plus a real Svelte server render of web/src/lib/EventDetail.svelte.
// It does not drive a browser; the Builder provides opened desktop/mobile
// screenshots and the a11y/lighthouse/visual gates in the combined PR.
//
// Contract the Builder implements (both twins, inside section.event-share):
// - Wrapper `data-testid="event-discord-times"` for eligible published
//   upcoming/ongoing events with wire-formattable instants only.
// - Selectable text `data-testid="event-discord-times-text"` (plain <p>/<pre>,
//   no hidden, no aria-hidden) with the deterministic minimal payload:
//     Starts <t:START_SECONDS:F> Ends <t:END_SECONDS:F> CANONICAL_URL
//   Labels are exactly "Starts"/"Ends"; tokens are seconds-based full-date
//   (`:F`) from the stored absolute instants via floor(ms/1000), never host
//   display strings or today's offset; the URL is the context-free canonical
//   `/e/:key` URL with no query. No title, attendees, identity, join details,
//   query, @everyone/@here or role mentions. Guest/member text identical.
// - Explicit copy `data-testid="event-discord-times-copy"` as
//   <button type="button"> named "Copy Discord times", carrying
//   `data-copy-discord-times="<payload>"` identical to the visible text.
// - Status `data-testid="event-discord-times-status"` as
//   <p role="status" aria-live="polite" data-discord-times-toast>, empty on
//   load. Success is announced only after clipboard completion:
//     success:     "Discord times copied."
//     failure:     "That didn't copy — select the Discord times above and copy them manually."
//     unconfirmed: "Copy not confirmed — if it isn't on your clipboard, select the Discord times above and copy them manually."
//   Pending work is bounded (deadline >0 and <=10000 ms, reset 4000 ms),
//   newer activations own feedback (no double-activation/late-completion
//   races), focus is never moved except restoring the prior selection owner,
//   and no automatic clipboard access, Discord API/bot post, notification,
//   fetch/XHR/beacon or navigator.share occurs.
// - Binder: assets/islands/copy-discord-times.js (reviewed source) built to
//   public/islands/copy-discord-times.js via `npm run build:assets` and loaded
//   with defer on the detail page. An extended copy-link.js that binds
//   [data-copy-discord-times] is also accepted; the tests locate either.
// - Suppression: no Discord-times markup for draft, cancelled (410),
//   ended/past or non-wire instants, using the existing shared state authority
//   (status gates plus isWireInstant). ICS/Google/Copy-link behavior and the
//   past-event wording stay unchanged.
// - Guidance: concise docs/event-discord-times.md (new, mirroring
//   docs/event-device-timezone.md) or an equivalent section in
//   docs/events-communications.md documenting tokens, canonical URL, manual
//   selection and honest copy feedback.
//
// RED now (named gap, not setup): eligible Hono/Kit markup, epoch/token pins,
// guest/member identity, binder behavior and guidance. CONTROL now (must stay
// green): ICS/Google/Copy-link preservation, suppression absence, no-auto
// clipboard/network, and past/cancelled wording.
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { runInNewContext } from "node:vm";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

type TestEnv = Env & { ADMIN_DB?: Db };

const ORIGIN = "https://events.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const CANONICAL = `${ORIGIN}${PATH}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const MEMBER_ID = "100000000000000001";
const MOD_ID = "100000000000000002";
const WORKTREE = fileURLToPath(new URL("../", import.meta.url));
const VIEWS = ["Hono", "Kit"] as const;
type View = (typeof VIEWS)[number];

// Independently calculated epoch seconds (floor(ms/1000)), never app helpers.
const START_2030 = 1894305600; // 2030-01-10T20:00:00.000Z
const END_2030 = 1894312800; // 2030-01-10T22:00:00.000Z
const SUMMER_2026 = 1784142000; // 2026-07-15T19:00:00.000Z
const WINTER_2026 = 1768507200; // 2026-01-15T20:00:00.000Z
const FOLD_FIRST = 1793511000; // 2026-11-01T05:30:00.000Z
const FOLD_SECOND = 1793514600; // 2026-11-01T06:30:00.000Z

const DISC_TESTID = "event-discord-times";
const DISC_TEXT_TESTID = "event-discord-times-text";
const DISC_COPY_TESTID = "event-discord-times-copy";
const DISC_STATUS_TESTID = "event-discord-times-status";
const SUCCESS_COPY = "Discord times copied.";
const FAILURE_COPY = "That didn't copy — select the Discord times above and copy them manually.";
const UNCONFIRMED_COPY =
  "Copy not confirmed — if it isn't on your clipboard, select the Discord times above and copy them manually.";

type EventRow = typeof events.$inferSelect;

function eventRow(over: Partial<EventRow> = {}): EventRow {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night @everyone <@&123>",
    game: "Chess",
    description: "Bring a board. Mention <@123> stays out of the payload.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

async function memberCookie(
  store: ReturnType<typeof createMemorySessionStore>,
  userId = MEMBER_ID,
  moderator = false,
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId === MOD_ID ? "moderator" : "member",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function honoHtml(
  over: Partial<EventRow> = {},
  opts: { cookie?: string; path?: string; appUrl?: string } = {},
): Promise<{ status: number; html: string }> {
  const row = eventRow(over);
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const store = createMemorySessionStore();
  const env = {
    APP_URL: opts.appUrl ?? ORIGIN,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: drizzle(async (sql) => {
      if (sql.includes("row_number()")) return { rows: [] };
      if (sql.includes('from "rsvps"')) {
        if (sql.includes("count(*)") || sql.includes("group by")) return { rows: [[row.id, 1]] };
        return { rows: [] };
      }
      if (sql.includes('"event_key" =')) {
        return {
          rows: [
            columns.map((key) =>
              row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
            ),
          ],
        };
      }
      return { rows: [] };
    }) as unknown as Db,
  } as unknown as Env;
  const cookie = opts.cookie ?? (opts.cookie === undefined ? undefined : opts.cookie);
  const response = await app.request(opts.path ?? PATH, cookie ? { headers: { cookie } } : {}, env);
  return { status: response.status, html: await response.text() };
}

async function honoMemberHtml(
  over: Partial<EventRow> = {},
  moderator = false,
): Promise<{ status: number; html: string }> {
  const row = eventRow(over);
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const store = createMemorySessionStore();
  const env = {
    APP_URL: ORIGIN,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: drizzle(async (sql) => {
      if (sql.includes("row_number()")) return { rows: [] };
      if (sql.includes('from "rsvps"')) {
        if (sql.includes("count(*)") || sql.includes("group by")) return { rows: [[row.id, 1]] };
        return { rows: [] };
      }
      if (sql.includes('"event_key" =')) {
        return {
          rows: [
            columns.map((key) =>
              row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
            ),
          ],
        };
      }
      return { rows: [] };
    }) as unknown as Db,
  } as unknown as Env;
  const cookie = await memberCookie(store, moderator ? MOD_ID : MEMBER_ID, moderator);
  const response = await app.request(PATH, { headers: { cookie } }, env);
  return { status: response.status, html: await response.text() };
}

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile(
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ): { js: { code: string } };
};
let kitPromise:
  | Promise<{ renderDetail(model: unknown): { head: string; body: string } }>
  | undefined;
function kitBundle() {
  kitPromise ??= (async () => {
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "discord-times-",
      ),
    );
    try {
      const component = JSON.stringify(join(WORKTREE, "web/src/lib/EventDetail.svelte"));
      const serverEntry = join(scratch, "server.mjs");
      const outfile = join(scratch, "server-bundle.mjs");
      writeFileSync(
        serverEntry,
        `import {render} from 'svelte/server'; import Detail from ${component}; export const renderDetail = model => render(Detail, {props:{model}});`,
      );
      await build({
        bundle: true,
        logLevel: "warning",
        absWorkingDir: WORKTREE,
        tsconfigRaw: { compilerOptions: {} },
        nodePaths: [join(WORKTREE, "web/node_modules"), join(WORKTREE, "node_modules")],
        alias: { "#lib": join(WORKTREE, "web/src/lib") },
        plugins: [
          {
            name: "discord-times-server",
            setup(plugin: import("esbuild").PluginBuild) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
                contents: compile(readFileSync(args.path, "utf8"), {
                  generate: "server",
                  dev: false,
                  filename: args.path,
                }).js.code,
                loader: "js",
                resolveDir: dirname(args.path),
              }));
            },
          },
        ],
        entryPoints: [serverEntry],
        platform: "node",
        format: "esm",
        outfile,
      });
      const server = await import(pathToFileURL(outfile).href);
      return {
        renderDetail: server.renderDetail as (model: unknown) => {
          head: string;
          body: string;
        },
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return kitPromise;
}

const GUEST_SESSION: KitRequestSession = { status: "guest", session: null };
function memberSession(moderator = false): KitRequestSession {
  return {
    status: "authenticated",
    session: {
      userId: moderator ? MOD_ID : MEMBER_ID,
      username: moderator ? "moderator" : "member",
      avatar: null,
      member: true,
      moderator,
    },
  };
}

async function kitHtml(
  over: Partial<EventRow> = {},
  opts: { session?: KitRequestSession; search?: string; appUrl?: string } = {},
): Promise<{ kind: string; html: string }> {
  const row = eventRow(over);
  const env = {
    APP_URL: opts.appUrl ?? ORIGIN,
    SESSION_SECRET: SECRET,
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as TestEnv;
  const store: KitEventDetailStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => ({ ...row, goingCount: 1, goingOccupancy: 1 }),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: opts.search ?? "",
    path: PATH,
    env,
    session: opts.session ?? GUEST_SESSION,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok") return { kind: outcome.kind, html: "" };
  const bundle = await kitBundle();
  const { head, body } = bundle.renderDetail(outcome.model);
  return {
    kind: outcome.kind,
    html: `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
  };
}

async function renderFixture(view: View, over: Partial<EventRow> = {}): Promise<string> {
  if (view === "Hono") return (await honoHtml(over)).html;
  return (await kitHtml(over)).html;
}

function shareSection(html: string): string {
  const start = html.indexOf('<section class="event-share"');
  expect(start, "named gap: share section missing").toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end, "unclosed share section").toBeGreaterThan(start);
  return html.slice(start, end);
}

function openingTag(html: string, testid: string, tag: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at, `named gap: missing testid ${testid}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf(`<${tag}`, at);
  expect(open, `named gap: testid ${testid} must sit on a <${tag}>`).toBeGreaterThan(-1);
  const end = html.indexOf(">", open);
  expect(end, `unclosed <${tag}> for ${testid}`).toBeGreaterThan(at);
  return html.slice(open, end + 1);
}

function discordTextOf(html: string): string {
  const at = html.indexOf(`data-testid="${DISC_TEXT_TESTID}"`);
  expect(at, `named gap: missing testid ${DISC_TEXT_TESTID}`).toBeGreaterThan(-1);
  const close = html.indexOf("</", at);
  const body = html.slice(html.indexOf(">", at) + 1, close);
  return body
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) scripts.push(match[1] ?? "");
  return scripts;
}

function binderSource(): { path: string; source: string } | null {
  const dedicated = [
    join(WORKTREE, "assets/islands/copy-discord-times.js"),
    join(WORKTREE, "public/islands/copy-discord-times.js"),
  ];
  for (const path of dedicated) {
    if (existsSync(path)) return { path, source: readFileSync(path, "utf8") };
  }
  // An extended copy-link binder that owns the new data attribute is accepted.
  for (const path of [
    join(WORKTREE, "assets/islands/copy-link.js"),
    join(WORKTREE, "public/islands/copy-link.js"),
  ]) {
    if (existsSync(path)) {
      const source = readFileSync(path, "utf8");
      if (source.includes("data-copy-discord-times")) return { path, source };
    }
  }
  return null;
}

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function discordBrowser(
  binder: string,
  payload: string,
  opts: { clipboard?: boolean; copied?: boolean } = {},
) {
  const toast = { textContent: "" };
  const active = { focus: vi.fn() };
  const selection = {
    rangeCount: 0,
    getRangeAt: vi.fn(),
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  const field = {
    value: "",
    className: "",
    tabIndex: 0,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const attributes = new Map([["data-copy-discord-times", payload]]);
  let click: (e: { button: number; preventDefault: () => void }) => void = () => {};
  const trigger = {
    getAttribute: (key: string) => attributes.get(key),
    addEventListener: (kind: string, fn: typeof click) => {
      if (kind === "click") click = fn;
    },
  };
  const writes: Deferred[] = [];
  const writeText = vi.fn(() => {
    const d = deferred();
    writes.push(d);
    return d.promise;
  });
  const exec = vi.fn(() => opts.copied ?? true);
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const setTimeout = vi.fn((fn: () => void, _ms: number) => {
    timers.set(++timerId, fn);
    return timerId;
  });
  const clearTimeout = vi.fn((id: number) => {
    timers.delete(id);
  });
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) =>
        selector === "[data-copy-discord-times]"
          ? trigger
          : selector === "[data-discord-times-toast]"
            ? toast
            : null,
      activeElement: active,
      createElement: () => field,
      body: { appendChild: vi.fn() },
      execCommand: exec,
    },
    window: { getSelection: () => selection },
    navigator: opts.clipboard === false ? {} : { clipboard: { writeText } },
    setTimeout,
    clearTimeout,
  });
  return {
    toast,
    active,
    field,
    exec,
    writeText,
    writes,
    timers,
    setTimeout,
    clearTimeout,
    click() {
      click({ button: 0, preventDefault: vi.fn() });
    },
    runTimer: (call: number) => setTimeout.mock.calls[call]![0](),
  };
}

const DISCORD_PAYLOAD = `Starts <t:${START_2030}:F> Ends <t:${END_2030}:F> ${CANONICAL}`;

for (const view of VIEWS) {
  describe(`${view} Discord times eligible contract`, () => {
    it("renders the selectable summary with labelled full-date tokens and the canonical URL inside the share area", async () => {
      const html = await renderFixture(view);
      const share = shareSection(html);
      expect(share, "named gap: Discord times must live in the share area").toContain(
        `data-testid="${DISC_TESTID}"`,
      );
      expect(html).toContain(`data-testid="${DISC_TEXT_TESTID}"`);
      const text = discordTextOf(html);
      expect(text).toContain("Starts");
      expect(text).toContain(`<t:${START_2030}:F>`);
      expect(text).toContain("Ends");
      expect(text).toContain(`<t:${END_2030}:F>`);
      expect(text).toContain(CANONICAL);
      // Order is part of the portable contract: Starts, then Ends, then URL.
      expect(text.indexOf("Starts")).toBeLessThan(text.indexOf(`<t:${START_2030}:F>`));
      expect(text.indexOf(`<t:${START_2030}:F>`)).toBeLessThan(text.indexOf("Ends"));
      expect(text.indexOf("Ends")).toBeLessThan(text.indexOf(`<t:${END_2030}:F>`));
      expect(text.indexOf(`<t:${END_2030}:F>`)).toBeLessThan(text.indexOf(CANONICAL));
      // Manually selectable without JavaScript: plain visible text, never hidden.
      const tag = openingTag(html, DISC_TEXT_TESTID, "p");
      expect(tag).not.toContain("hidden");
      expect(tag).not.toContain("aria-hidden");
      expect(tag).not.toContain("display:none");
      expect(tag).not.toContain("sr-only");
      // Explicit copy action plus an empty polite status on fresh render.
      const copyTag = openingTag(html, DISC_COPY_TESTID, "button");
      expect(copyTag).toContain('type="button"');
      expect(copyTag).not.toContain("autofocus");
      const copyAt = html.indexOf(`data-testid="${DISC_COPY_TESTID}"`);
      const copyBody = html
        .slice(html.indexOf(">", copyAt) + 1, html.indexOf("</button>", copyAt))
        .trim();
      const copyLabel = `${copyTag} ${copyBody}`;
      expect(copyLabel).toMatch(/Copy Discord times/);
      const statusTag = openingTag(html, DISC_STATUS_TESTID, "p");
      expect(statusTag).toContain('role="status"');
      expect(statusTag).toContain('aria-live="polite"');
      expect(statusTag).not.toContain("assertive");
      const statusAt = html.indexOf(`data-testid="${DISC_STATUS_TESTID}"`);
      const statusBody = html
        .slice(html.indexOf(">", statusAt) + 1, html.indexOf("</p>", statusAt))
        .trim();
      expect(statusBody, "fresh render never pre-announces a copy").toBe("");
    });

    it("keeps a deterministic minimal payload with no private or mass-mention text", async () => {
      const html = await renderFixture(view, {
        join_url: "https://voice.example.test/secret-room?key=abc",
        join_instructions: "Knock twice and mention @here for entry",
        location: "The lobby @everyone",
      } as Partial<EventRow>);
      const text = discordTextOf(html);
      expect(text).not.toContain("Chess night");
      expect(text).not.toContain("@everyone");
      expect(text).not.toContain("@here");
      expect(text).not.toContain("<@");
      expect(text).not.toContain("<#");
      expect(text).not.toContain("@&");
      expect(text).not.toContain("voice.example.test");
      expect(text).not.toContain("Knock twice");
      expect(text).not.toContain("The lobby");
      expect(text).not.toContain("utm_");
      expect(text).not.toContain("attendees=");
      expect(text).not.toContain("?");
      expect(text).not.toContain("discord.com/api");
      // Only fixed labels, two validated tokens and the canonical URL.
      const tokens = text.match(/<t:\d+:F>/g) ?? [];
      expect(tokens).toHaveLength(2);
      expect(text).toMatch(/^Starts <t:\d+:F> Ends <t:\d+:F> https:\/\/\S+$/);
    });

    it("floors subsecond instants to whole seconds, never milliseconds or rounded-up display", async () => {
      const html = await renderFixture(view, {
        startsAt: new Date("2030-01-10T20:00:00.789Z"),
        endsAt: new Date("2030-01-10T22:00:00.123Z"),
      });
      const text = discordTextOf(html);
      expect(text).toContain(`<t:${START_2030}:F>`);
      expect(text).toContain(`<t:${END_2030}:F>`);
      expect(text).not.toContain("1894305600789");
      expect(text).not.toContain("1894312800123");
      expect(text).not.toContain(`${START_2030 + 1}`);
      expect(text).not.toContain(`${END_2030 + 1}`);
      expect(text).not.toMatch(/<t:\d{13,}:/);
    });

    it("keeps tokens identical across host timezones for the same absolute instant", async () => {
      const startsAt = new Date("2026-07-15T19:00:00.000Z");
      const endsAt = new Date("2026-07-15T21:00:00.000Z");
      const texts: string[] = [];
      for (const timezone of ["UTC", "America/New_York", "Europe/London"]) {
        const html = await renderFixture(view, { startsAt, endsAt, timezone });
        texts.push(discordTextOf(html));
      }
      for (const text of texts) {
        expect(text).toContain(`<t:${SUMMER_2026}:F>`);
        expect(text).not.toContain("1784142");
      }
      expect(texts[1]).toBe(texts[0]);
      expect(texts[2]).toBe(texts[0]);
    });

    it("separates the DST fold pair: same wall clock, different absolute tokens", async () => {
      const first = await renderFixture(view, {
        startsAt: new Date("2026-11-01T05:30:00.000Z"),
        endsAt: new Date("2026-11-01T07:30:00.000Z"),
        timezone: "America/New_York",
      });
      const second = await renderFixture(view, {
        startsAt: new Date("2026-11-01T06:30:00.000Z"),
        endsAt: new Date("2026-11-01T08:30:00.000Z"),
        timezone: "America/New_York",
      });
      expect(discordTextOf(first)).toContain(`<t:${FOLD_FIRST}:F>`);
      expect(discordTextOf(second)).toContain(`<t:${FOLD_SECOND}:F>`);
      expect(discordTextOf(first)).not.toContain(`<t:${FOLD_SECOND}:F>`);
      expect(discordTextOf(second)).not.toContain(`<t:${FOLD_FIRST}:F>`);
    });

    it("separates start and end instants with distinct tokens", async () => {
      const html = await renderFixture(view);
      const text = discordTextOf(html);
      expect(START_2030).not.toBe(END_2030);
      expect(text).toContain(`<t:${START_2030}:F>`);
      expect(text).toContain(`<t:${END_2030}:F>`);
      const winter = await renderFixture(view, {
        startsAt: new Date("2026-01-15T20:00:00.000Z"),
        endsAt: new Date("2026-01-15T22:00:00.000Z"),
      });
      // A winter instant never reuses today's summer offset: the token is the
      // stored absolute instant, pinned literally.
      expect(discordTextOf(winter)).toContain(`<t:${WINTER_2026}:F>`);
      expect(discordTextOf(winter)).not.toContain(`<t:${START_2030}:F>`);
    });

    it("isolates the canonical URL from query context and a trailing-slash APP_URL", async () => {
      const html =
        view === "Hono"
          ? (
              await honoHtml(
                {},
                { path: `${PATH}?utm_source=discord&attendees=2`, appUrl: `${ORIGIN}/` },
              )
            ).html
          : (await kitHtml({}, { search: "?utm_source=discord&attendees=2", appUrl: `${ORIGIN}/` }))
              .html;
      const text = discordTextOf(html);
      expect(text).toContain(CANONICAL);
      expect(text).not.toContain("utm_source");
      expect(text).not.toContain("attendees=");
      expect(text).not.toContain("?");
      expect(text).not.toContain("//e/");
    });

    it("renders identical Discord text for guest and member viewers", async () => {
      const guest =
        view === "Hono"
          ? (await honoHtml({})).html
          : (await kitHtml({}, { session: GUEST_SESSION })).html;
      const member =
        view === "Hono"
          ? (await honoMemberHtml({})).html
          : (await kitHtml({}, { session: memberSession() })).html;
      expect(discordTextOf(member)).toBe(discordTextOf(guest));
      expect(discordTextOf(member)).not.toContain("member");
      expect(discordTextOf(member)).not.toContain(MEMBER_ID);
    });

    it("covers ongoing events: started in the past, ending in the future", async () => {
      const html = await renderFixture(view, {
        startsAt: new Date("2026-01-15T20:00:00.000Z"),
        endsAt: new Date("2030-01-10T22:00:00.000Z"),
      });
      const text = discordTextOf(html);
      expect(text).toContain(`<t:${WINTER_2026}:F>`);
      expect(text).toContain(`<t:${END_2030}:F>`);
    });

    it("performs no automatic clipboard access, Discord post or network request", async () => {
      const html = await renderFixture(view);
      expect(html).not.toContain("discord.com/api");
      expect(html).not.toContain("discordapp.com/api");
      for (const inline of inlineScripts(html)) {
        expect(inline).not.toContain("navigator.clipboard");
        expect(inline).not.toContain("writeText");
        expect(inline).not.toContain("fetch(");
        expect(inline).not.toContain("XMLHttpRequest");
        expect(inline).not.toContain("sendBeacon");
        expect(inline).not.toContain("navigator.share");
      }
      // Deferred islands only; the payload is present before any script runs.
      expect(html).toContain(`data-testid="${DISC_TEXT_TESTID}"`);
    });
  });

  describe(`${view} Discord times suppression (controls)`, () => {
    it("control: draft renders without Discord times but keeps the existing share links", async () => {
      const html =
        view === "Hono"
          ? (await honoMemberHtml({ status: "draft" }, true)).html
          : (await kitHtml({ status: "draft" }, { session: memberSession(true) })).html;
      expect(html).toContain('data-testid="event-draft"');
      expect(html).not.toContain(`data-testid="${DISC_TESTID}"`);
      expect(html).not.toContain(`data-testid="${DISC_TEXT_TESTID}"`);
      expect(html).not.toContain(`data-testid="${DISC_COPY_TESTID}"`);
      expect(html).toContain('data-testid="event-ics"');
      expect(html).toContain('data-testid="event-copy-link"');
    });

    it("control: cancelled stays a share-free 410/gone with no Discord times", async () => {
      if (view === "Hono") {
        const { status, html } = await honoHtml({ status: "cancelled" });
        expect(status).toBe(410);
        expect(html).not.toContain(`data-testid="${DISC_TESTID}"`);
        expect(html).not.toContain("event-copy-link");
      } else {
        const { kind, html } = await kitHtml({ status: "cancelled" });
        expect(kind).toBe("gone");
        expect(html).toBe("");
      }
    });

    it("control: ended past events keep past wording with no Discord times", async () => {
      const html = await renderFixture(view, {
        status: "past",
        startsAt: new Date("2020-01-10T20:00:00Z"),
        endsAt: new Date("2020-01-10T22:00:00Z"),
      });
      expect(html).toContain('data-testid="event-past"');
      expect(html).not.toContain(`data-testid="${DISC_TESTID}"`);
    });

    it("control: published but already-ended rows suppress Discord times", async () => {
      const html = await renderFixture(view, {
        status: "published",
        startsAt: new Date("2020-01-10T20:00:00Z"),
        endsAt: new Date("2020-01-10T22:00:00Z"),
      });
      expect(html).not.toContain(`data-testid="${DISC_TESTID}"`);
    });

    it.each([
      ["expanded endsAt only", "2030-01-10T20:00:00Z", "+010000-01-10T22:00:00Z"],
      ["negative startsAt only", "-000001-01-10T20:00:00Z", "2030-01-10T22:00:00Z"],
    ])(
      "control: %s keeps the page 200 with existing links but no Discord times",
      async (_label, startsAt, endsAt) => {
        const html = await renderFixture(view, {
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
        });
        expect(html).toContain('data-testid="event-ics"');
        expect(html).toContain('data-testid="event-copy-link"');
        expect(html).not.toContain("calendar.google.com");
        expect(html).not.toContain(`data-testid="${DISC_TESTID}"`);
      },
    );
  });

  describe(`${view} Discord times preservation (controls)`, () => {
    it("control: eligible pages keep ICS, Google, Copy link and the share heading", async () => {
      const html = await renderFixture(view);
      expect(html).toContain('id="event-share-heading">Save the date</h2>');
      expect(html).toContain('data-testid="event-ics"');
      expect(html).toContain('data-testid="event-google-calendar"');
      expect(html).toContain(
        `href="${CANONICAL}" data-copy-link="${CANONICAL}" data-testid="event-copy-link">`,
      );
      expect(html).toContain('data-testid="event-copy-toast"');
    });

    it("control: guest share area never carries attendee identities or mass mentions", async () => {
      const html = await renderFixture(view);
      // The exclusion fixture is active: the tricky title renders in the h1.
      expect(html).toContain("Chess night @everyone");
      expect(html).not.toContain("/members/");
      const share = shareSection(html);
      expect(share).not.toContain("@everyone");
      expect(share).not.toContain("@here");
      expect(share).not.toContain("<@");
    });
  });
}

describe("Discord times copy binder", () => {
  it("names the gap: a Discord-times copy binder is shipped with the page", () => {
    const binder = binderSource();
    expect(
      binder,
      "named gap: assets/islands/copy-discord-times.js (built to public/) or an extended copy-link.js binding [data-copy-discord-times]",
    ).not.toBeNull();
  });

  it("copies the exact payload after explicit activation and announces success politely", async () => {
    const binder = binderSource();
    expect(binder, "named gap: no Discord-times binder to execute").not.toBeNull();
    const b = discordBrowser(binder!.source, DISCORD_PAYLOAD);
    expect(b.toast.textContent).toBe("");
    expect(b.writeText).not.toHaveBeenCalled();
    b.click();
    expect(b.writeText).toHaveBeenCalledTimes(1);
    expect(b.writeText).toHaveBeenCalledWith(DISCORD_PAYLOAD);
    b.writes[0]!.resolve();
    await settle();
    expect(b.toast.textContent).toBe(SUCCESS_COPY);
    expect(b.exec).not.toHaveBeenCalled();
    // Polite reset on the shared four-second cadence.
    expect(b.setTimeout).toHaveBeenCalledWith(expect.any(Function), 4000);
    b.timers.values().next().value!();
    expect(b.toast.textContent).toBe("");
  });

  it("reports rejected or missing clipboard honestly with selectable-text recovery", async () => {
    const binder = binderSource();
    expect(binder, "named gap: no Discord-times binder to execute").not.toBeNull();
    for (const mode of ["rejected", "missing"] as const) {
      const b = discordBrowser(
        binder!.source,
        DISCORD_PAYLOAD,
        mode === "missing" ? { clipboard: false } : {},
      );
      b.click();
      if (mode === "rejected") {
        b.writes[0]!.reject(new Error("Denied"));
        await settle();
      } else {
        await settle();
      }
      expect(b.toast.textContent).toBe(FAILURE_COPY);
      expect(b.timers.size).toBe(1);
    }
  });

  it("bounds hanging work with a deadline and unconfirmed guidance, without a second write", async () => {
    const binder = binderSource();
    expect(binder, "named gap: no Discord-times binder to execute").not.toBeNull();
    const b = discordBrowser(binder!.source, DISCORD_PAYLOAD);
    b.click();
    const deadlineMs = b.setTimeout.mock.calls[0]?.[1] as number;
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThanOrEqual(10_000);
    b.runTimer(0);
    expect(b.toast.textContent).toBe(UNCONFIRMED_COPY);
    expect(b.writeText).toHaveBeenCalledTimes(1);
    expect(b.exec).not.toHaveBeenCalled();
  });

  it("drops late completion after the deadline instead of claiming a copy", async () => {
    const binder = binderSource();
    expect(binder, "named gap: no Discord-times binder to execute").not.toBeNull();
    const b = discordBrowser(binder!.source, DISCORD_PAYLOAD);
    b.click();
    b.runTimer(0);
    b.writes[0]!.resolve();
    await settle();
    expect(b.toast.textContent).toBe(UNCONFIRMED_COPY);
    const c = discordBrowser(binder!.source, DISCORD_PAYLOAD);
    c.click();
    c.runTimer(0);
    c.writes[0]!.reject(new Error("denied"));
    await settle();
    expect(c.toast.textContent).toBe(UNCONFIRMED_COPY);
    expect(c.exec).not.toHaveBeenCalled();
  });

  it("gives repeated activations to the newest attempt with no double-write race", async () => {
    const binder = binderSource();
    expect(binder, "named gap: no Discord-times binder to execute").not.toBeNull();
    const b = discordBrowser(binder!.source, DISCORD_PAYLOAD);
    b.click();
    b.click();
    expect(b.writeText).toHaveBeenCalledTimes(2);
    expect(b.toast.textContent).toBe("");
    b.writes[1]!.resolve();
    await settle();
    expect(b.toast.textContent).toBe(SUCCESS_COPY);
    b.writes[0]!.reject(new Error("denied"));
    await settle();
    expect(b.toast.textContent).toBe(SUCCESS_COPY);
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.timers.size).toBe(1);
  });

  it("never touches the clipboard on load and never posts to Discord or the network", () => {
    const binder = binderSource();
    expect(binder, "named gap: no Discord-times binder to execute").not.toBeNull();
    const source = binder!.source;
    expect(source).not.toContain("discord.com/api");
    expect(source).not.toContain("discordapp.com");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("XMLHttpRequest");
    expect(source).not.toContain("sendBeacon");
    expect(source).not.toContain("navigator.share");
    expect(source).not.toContain("@everyone");
    expect(source).not.toContain("@here");
    // The binder binds listeners; it never writes on evaluation.
    const b = discordBrowser(source, DISCORD_PAYLOAD);
    expect(b.writeText).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe("");
  });
});

describe("Discord times guidance", () => {
  it("names the gap: concise event-sharing guidance documents Discord times", () => {
    const candidates = [
      join(WORKTREE, "docs/event-discord-times.md"),
      join(WORKTREE, "docs/events-communications.md"),
    ];
    const bodies = candidates
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"));
    const combined = bodies.join("\n");
    expect(
      combined,
      "named gap: docs/event-discord-times.md (new, concise) or docs/events-communications.md must document the Discord times summary",
    ).toContain("Discord times");
    expect(combined).toContain("Starts");
    expect(combined).toContain("Ends");
    expect(combined).toContain("<t:");
    expect(combined).toContain(":F>");
  });
});
