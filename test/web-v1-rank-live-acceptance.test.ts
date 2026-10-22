// ACCEPTANCE, owned by the Test Author. The Builder builds on this branch and
// MUST NEVER edit this file: these tests are the contract. Failing-first per
// the live-data principle (event voice channels epic, SPEC section 4):
// ladder prose/counts render from web_v1.rank_counts + rank_ladder.role_id,
// and the static copy survives only as null-state fallback.
//
// Contract the Builder implements:
// - Bot-owned read: web_v1.rank_counts (rank_key, rank_label, member_count,
//   rank_order) joined with web_v1.rank_ladder (rank_key, role_id). The ladder
//   fixture below defines the rank_ladder shape: one row per rank key, role_id
//   nullable text. A rank WITHOUT a ladder row still renders (ladder
//   completeness comes from rank_counts); it just carries no role.
// - Rendered role: each rank card carries data-role-id="<role_id>" when the
//   ladder row exists, and no data-role-id attribute at all when it does not.
// - Ladder prose derives from the live labels: the home heading is the labels
//   joined with " -> " in rank_order; the FAQ rungs answer and the About/FAQ
//   entry sentences name the live rungs; "{top} is still unclaimed" appears
//   if and only if the top rung count is exactly 0 (unknown is not zero).
// - Shared seams: faqPageData(appUrl, ranks?) and aboutPageData(appUrl, ranks?)
//   take an optional ordered ranks array and return the same shape as today.
//   Without ranks they return the current static bytes (null-state). The ranks
//   input is [{ key, label, memberCount }] in rank_order; extra fields (such
//   as roleId) are ignored. The casts below keep this file compiling both
//   before and after the Builder adds the optional parameter.
// - "Gone or demoted" needs no deletion pin: these tests pass whether
//   FALLBACK_RANKS is deleted or kept as the null-state-only source, because
//   they assert behavior (live data in, static out) rather than imports. This
//   file deliberately does NOT import FALLBACK_RANKS: the hard-coded names
//   below are frozen literals, so the tests survive its deletion.
// - Scope note: the home community-intro "Become a Member" is funnel copy, not
//   ladder prose, but it is still a hard-coded rank fact, so the live tests
//   require it gone too (lowercase generic "member" or a live derivation both
//   satisfy the assertions). Editorial copy without a live source (Est. 1998,
//   18+ evenings, invite fallback) is untouched and unpinned here.
//
// Failing map (run with DATABASE_URL against a disposable test database):
// - Section A (Hono, DB-backed): A1/A3/A5/A7/A8/A9 fail now on the hard-coded
//   heading, stack sentence, rungs answer and About fact; A2/A4/A6/A10 are
//   null-state/robustness guards that pass now and must keep passing.
// - Section B (no DB): B1 fails now on the Kit hard-coded heading; B3/B5/B7/B8
//   fail now because the shared seams ignore the ranks argument; B2/B4/B6 are
//   null-state guards that pass now and must keep passing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  ABOUT_FACTS,
  ABOUT_LEAD,
  ABOUT_STRAP,
  aboutPageData,
  type AboutPageData,
} from "../src/about-content";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { FAQS, faqPageData } from "../src/faq-content";
import { HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";
import { createMemorySessionStore } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { createWebV1Fixture, type WebV1Fixture } from "./helpers/web-v1-fixture";

// Frozen copy of the hard-coded ladder, byte-equal to the static sources but
// intentionally NOT imported from them: these assertions must keep compiling
// after the Builder deletes or demotes FALLBACK_RANKS and the static prose.
const HARDCODED_RANK_NAMES = ["Prospect", "Member", "Soldier", "Veteran", "Legend"];

// The static sentences the live render must stop emitting. Frozen literals
// for the same reason: the test pins the disappearance of these bytes.
const STATIC_LADDER_HEADING = "Prospect → Member → Soldier → Veteran → Legend";
const STATIC_STACK_SENTENCE = "Ranks stack — a Veteran still holds everything below.";
const STATIC_RUNGS_ANSWER =
  "Five, in order: Prospect → Member → Soldier → Veteran → Legend. Ranks stack — a Veteran still holds everything below. Legend is still unclaimed.";
const STATIC_ABOUT_LADDER =
  "You start as a Prospect. Show up a few times, play, become a Member. The ladder records trust and time, not grind.";

// Distinctive live rungs: none of these words appears anywhere in the static
// copy, so presence proves live derivation and absence of the frozen names
// proves the hard-coded fallbacks are gone from the render.
const LIVE_LABELS = ["Ember", "Tide", "Stone", "Thorn", "Crown"];
const LIVE_ORDER = LIVE_LABELS.join(" → ");
const LIVE_ROLE_IDS = {
  ember: "1387000000000000001",
  tide: "1387000000000000002",
  stone: "1387000000000000003",
  crown: "1387000000000000005",
} as const;

type RankInput = {
  key: string;
  label: string;
  memberCount: number | null;
  roleId?: string | null;
};

// Mirror of the Section A seed (counts, nulls and the thorn role gap match
// the fixture rows exactly): the Kit render and shared-seam pins below run
// without a database but against the same live shape.
const LIVE_RANKS: RankInput[] = [
  { key: "ember", label: "Ember", memberCount: 24, roleId: LIVE_ROLE_IDS.ember },
  { key: "tide", label: "Tide", memberCount: 40, roleId: LIVE_ROLE_IDS.tide },
  { key: "stone", label: "Stone", memberCount: 0, roleId: LIVE_ROLE_IDS.stone },
  { key: "thorn", label: "Thorn", memberCount: null, roleId: null },
  { key: "crown", label: "Crown", memberCount: 3, roleId: LIVE_ROLE_IDS.crown },
];

// Null-state rungs for the Kit fake load data: byte-equal to the current
// FALLBACK_RANKS, passed under the current homeCopy key. Whether the Builder
// keeps reading data.homeCopy.FALLBACK_RANKS or moves the null-state list into
// the component, the render shows these bytes when ranks are empty.
const NULL_STATE_RANKS = [
  { key: "prospect", label: "Prospect", memberCount: null },
  { key: "member", label: "Member", memberCount: null },
  { key: "soldier", label: "Soldier", memberCount: null },
  { key: "veteran", label: "Veteran", memberCount: null },
  { key: "legend", label: "Legend", memberCount: null },
];

// Word-boundary match: "Members" nav links, "84 members" counts and
// data-rank="member" keys are not the hard-coded rank fact "Member".
function expectNoHardcodedRanks(html: string) {
  for (const name of HARDCODED_RANK_NAMES) {
    expect(html).not.toMatch(new RegExp(`\\b${name}\\b`));
  }
}

// Svelte SSR keeps the newline between </dt> and <dd>; Hono JSX strips it.
// Collapse inter-tag whitespace so both renderers meet the same pair pins.
function compact(html: string): string {
  return html.replace(/>\s+</g, "><");
}

function ladderSection(html: string): string {
  const section = html.match(/aria-label="Community ladder"[\s\S]*?<\/section>/);
  expect(section?.[0]).toBeDefined();
  return section?.[0] ?? "";
}

function rankCard(html: string, key: string): string {
  const card = html.match(new RegExp(`<div[^>]*data-rank="${key}"[^>]*>[\\s\\S]*?<\\/div>`));
  expect(card?.[0]).toBeDefined();
  return card?.[0] ?? "";
}

// ---------------------------------------------------------------------------
// Section A: Hono leaves through the real app with a real web_v1 fixture.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  fixture: null as WebV1Fixture | null,
}));
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return {
    default: (raw: string, options: Record<string, unknown>) => {
      const url = testDatabaseUrl(raw); // Even the driver double refuses non-test URLs.
      if (!state.fixture) return original(url.href, { ...options, password: () => url.password });
      const sql = (parts: TemplateStringsArray, ...values: unknown[]) => {
        return state.fixture!.sql(parts, ...(values as postgres.ParameterOrFragment<never>[]));
      };
      sql.end = async () => {}; // Fixture owns the transaction/socket, not the request.
      return sql;
    },
  };
});

const NOW = Date.parse("2026-09-30T12:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "test-client",
  DISCORD_GUILD_ID: "test-guild",
  DISCORD_INVITE_URL: "https://discord.gg/test",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_BOT_TOKEN: "test-bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe.skipIf(!process.env.DATABASE_URL)("web_v1 rank data replaces hard-coded fallbacks", () => {
  let fixture: WebV1Fixture;
  let env: Env;
  let app: typeof import("../src/index")["default"];

  beforeEach(async () => {
    vi.resetModules();
    fixture = await createWebV1Fixture(process.env.DATABASE_URL!);
    const sql = fixture.sql;
    await sql`CREATE TABLE web_v1.rank_ladder (rank_key text NOT NULL, role_id text)`;
    await sql`
      INSERT INTO web_v1.live_counts VALUES (84, 12, ${new Date(NOW).toISOString()}::text)
    `;
    // Deliberately scrambled insertion order: the render order comes from
    // rank_order, never from insertion. Thorn has no ladder row on purpose.
    await sql`
      INSERT INTO web_v1.rank_counts VALUES
      ('crown', 'Crown', 3, 5), ('ember', 'Ember', 24, 1), ('thorn', 'Thorn', NULL, 4),
      ('stone', 'Stone', 0, 3), ('tide', 'Tide', 40, 2)
    `;
    await sql`
      INSERT INTO web_v1.rank_ladder VALUES
      ('ember', '1387000000000000001'), ('tide', '1387000000000000002'),
      ('stone', '1387000000000000003'), ('crown', '1387000000000000005')
    `;
    state.fixture = fixture;
    // Keep event/featured reads local and separate from the bot-view socket.
    const event: typeof events.$inferSelect = {
      id: 1,
      icsSequence: 1n,
      eventKey: "rank-acceptance-game-night",
      title: "Rank acceptance game night",
      game: null,
      description: null,
      startsAt: new Date(NOW + 3600_000),
      endsAt: new Date(NOW + 7200_000),
      timezone: "UTC",
      location: "Lobby",
      capacity: null,
      status: "published",
      discordEventId: null,
      syncRevision: 1,
      syncedRevision: 0,
      discordSyncFailedAt: null,
      discordSyncFailureCode: null,
      agentGrantId: null,
      proofMarker: null,
      agentVersion: 1,
      createdBy: null,
      rsvpOpen: true,
      recurrenceFrequency: null,
      recurrenceCount: null,
      recurrenceEndsOn: null,
      parentEventId: null,
      recurrenceIndex: null,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof event)[];
    const db = drizzle(async (query) => {
      if (query.includes("set_config")) return { rows: [] };
      if (query.includes('"timezone"') && !query.includes('"title"')) return { rows: [] };
      if (query.includes('from "events"'))
        return {
          rows: [
            columns.map((key) => {
              const value = event[key];
              return value instanceof Date ? value.toISOString() : value;
            }),
          ],
        };
      if (query.includes('from "rsvps"')) return { rows: [[1, 3]] };
      if (query.includes('from "featured_contents"'))
        return { rows: [[1, "Rank acceptance news", "Featured fixture", null, null, null]] };
      throw new Error("Unexpected public homepage fixture query");
    }) as unknown as Db;
    Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
    env = {
      ...baseEnv,
      BOT_DB: { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href },
      ADMIN_DB: db,
      SESSION_STORE: createMemorySessionStore(),
      DISCORD_EVENTS: {
        upcoming: async () => [],
        lastReadFailed: () => false,
      },
    } as Env;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    app = (await import("../src/index")).default;
  });
  afterEach(async () => {
    state.fixture = null;
    vi.restoreAllMocks();
    await fixture?.dispose();
  });

  const get = async (path: string) => {
    const res = await app.request(new URL(path, env.APP_URL).href, {}, env);
    expect(res.status).toBe(200);
    return res.text();
  };

  it("A1: home ladder heading, rows, counts and roles render from web_v1", async () => {
    const html = await get("/");
    // The page rendered fully around the ladder (not a degraded shell).
    expect(html).toContain("Rank acceptance game night");
    expect(html).toContain("Rank acceptance news");
    const ladder = ladderSection(html);
    expect(ladder).toContain(`<h2>${LIVE_ORDER}</h2>`);
    const pairs = compact(ladder);
    expect(pairs).toContain("<dt>Ember</dt><dd>24</dd>");
    expect(pairs).toContain("<dt>Tide</dt><dd>40</dd>");
    expect(pairs).toContain("<dt>Stone</dt><dd>unclaimed</dd>");
    expect(pairs).toContain("<dt>Thorn</dt><dd></dd>");
    expect(pairs).toContain("<dt>Crown</dt><dd>3</dd>");
    // rank_order, not insertion order.
    const ordered = ["ember", "tide", "stone", "thorn", "crown"].map((key) =>
      ladder.indexOf(`data-rank="${key}"`),
    );
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    // Every mapped rung carries its ladder role; the unmapped rung still
    // renders (completeness comes from rank_counts) with no role attribute.
    for (const [key, roleId] of Object.entries(LIVE_ROLE_IDS)) {
      expect(rankCard(ladder, key)).toContain(`data-role-id="${roleId}"`);
    }
    expect(rankCard(ladder, "thorn")).not.toContain("data-role-id");
    // None of the hard-coded rank names anywhere on the page — including the
    // funnel "Become a Member" sentence, which names the Member rank.
    expectNoHardcodedRanks(html);
    expect(html).not.toContain(STATIC_LADDER_HEADING);
    expect(html).not.toContain(STATIC_STACK_SENTENCE);
  });

  it("A2: home null-state keeps the static ladder when web_v1 is unavailable", async () => {
    await fixture.sql`DROP SCHEMA web_v1 CASCADE`;
    const html = await get("/");
    expect(html).toContain('data-testid="rank-stack"');
    const pairs = compact(ladderSection(html));
    for (const rank of HARDCODED_RANK_NAMES) {
      expect(pairs).toContain(`<dt>${rank}</dt><dd></dd>`);
    }
    expect(html).not.toContain("unclaimed"); // Unknown is not zero.
    expect(html).toContain(STATIC_LADDER_HEADING);
  });

  it("A3: FAQ rungs and entry answers render from web_v1", async () => {
    const html = await get("/faq");
    expect(html).toContain("faq-ranks"); // The ranks section rendered.
    expect(html).toContain(LIVE_ORDER);
    expect(html).toContain("Ranks stack");
    expect(html).toContain("Thorn still holds everything below");
    // Top rung Crown holds 3: no unclaimed claim of any kind.
    expect(html).not.toContain("still unclaimed");
    // The entry answer names the live entry rungs.
    expect(html).toContain("Ember");
    expect(html).toContain("Tide");
    expectNoHardcodedRanks(html);
    expect(html).not.toContain(STATIC_RUNGS_ANSWER);
  });

  it("A4: FAQ null-state keeps the static rungs answer when web_v1 is unavailable", async () => {
    await fixture.sql`DROP SCHEMA web_v1 CASCADE`;
    const html = await get("/faq");
    expect(html).toContain(STATIC_RUNGS_ANSWER);
    expect(html).toContain("Legend is still unclaimed");
  });

  it("A5: About ladder fact renders from web_v1", async () => {
    const html = await get("/about");
    expect(html).toContain("Est. 1998"); // Editorial copy stays static.
    expect(html).toContain("Ember");
    expect(html).toContain("Tide");
    expect(html).toContain("The ladder records trust and time, not grind.");
    expectNoHardcodedRanks(html);
    expect(html).not.toContain(STATIC_ABOUT_LADDER);
  });

  it("A6: About null-state keeps the static ladder fact when web_v1 is unavailable", async () => {
    await fixture.sql`DROP SCHEMA web_v1 CASCADE`;
    const html = await get("/about");
    expect(html).toContain(STATIC_ABOUT_LADDER);
  });

  it("A7: ladder prose derives the rung count and order, not just the names", async () => {
    await fixture.sql`DELETE FROM web_v1.rank_counts WHERE rank_key IN ('tide', 'thorn')`;
    await fixture.sql`UPDATE web_v1.rank_counts SET member_count = 0 WHERE rank_key = 'crown'`;
    const home = await get("/");
    expect(ladderSection(home)).toContain("<h2>Ember → Stone → Crown</h2>");
    expectNoHardcodedRanks(home);
    const faq = await get("/faq");
    expect(faq).not.toContain("Five, in order");
    expect(faq).toContain("Ember → Stone → Crown");
    expect(faq).toContain("Crown is still unclaimed");
    expectNoHardcodedRanks(faq);
  });

  it("A8: FAQ derives the unclaimed claim from a zero top rung", async () => {
    await fixture.sql`UPDATE web_v1.rank_counts SET member_count = 0 WHERE rank_key = 'crown'`;
    expect(await get("/faq")).toContain("Crown is still unclaimed");
  });

  it("A9: an unknown top rung is not unclaimed", async () => {
    await fixture.sql`UPDATE web_v1.rank_counts SET member_count = NULL WHERE rank_key = 'crown'`;
    const [faq, home] = [await get("/faq"), await get("/")];
    expect(faq).not.toContain("still unclaimed");
    expect(compact(ladderSection(home))).toContain("<dt>Crown</dt><dd></dd>");
    expectNoHardcodedRanks(home);
  });

  it("A10: a missing rank_ladder never empties the ladder or 500s", async () => {
    await fixture.sql`DROP TABLE web_v1.rank_ladder`;
    const home = await get("/");
    expect(home).toContain('data-testid="rank-stack"');
    expect(ladderSection(home)).toContain("<dt>");
    expect(await get("/faq")).toContain("faq-ranks");
  });
});

// ---------------------------------------------------------------------------
// Section B: Kit SSR render and shared content seams (no database).
// ---------------------------------------------------------------------------

// The shared seams take an optional ordered ranks array after this card. The
// casts keep this file compiling both before the Builder adds the parameter
// (extra argument ignored) and after (derived content returned).
type LiveFaqPageData = (
  appUrl: string,
  ranks?: RankInput[],
) => { appUrl: string; faqs: typeof FAQS };
type LiveAboutPageData = (appUrl: string, ranks?: RankInput[]) => AboutPageData;
const liveFaqPageData = faqPageData as LiveFaqPageData;
const liveAboutPageData = aboutPageData as LiveAboutPageData;

function faqAnswer(faqs: typeof FAQS, question: string): string {
  const found = faqs.flatMap((group) => group.items).find(([q]) => q === question);
  expect(found?.[1]).toBeDefined();
  return found?.[1] ?? "";
}

function aboutFact(facts: typeof ABOUT_FACTS, term: string): string {
  const found = facts.find(([t]) => t === term);
  expect(found?.[1]).toBeDefined();
  return found?.[1] ?? "";
}

describe("web_v1 rank data: shared content seams", () => {
  const APP_URL = "https://next.example.test";

  it("B3: faqPageData derives the rungs and entry answers from ranks", () => {
    const { faqs } = liveFaqPageData(APP_URL, LIVE_RANKS);
    const rungs = faqAnswer(faqs, "What are the rank rungs?");
    expect(rungs).toContain(LIVE_ORDER);
    expect(rungs).toContain("Ranks stack");
    expect(rungs).toContain("Thorn still holds everything below");
    expect(rungs).not.toContain("still unclaimed");
    expectNoHardcodedRanks(rungs);
    const application = faqAnswer(
      faqs,
      "Is there an application, interview, or skill requirement?",
    );
    expect(application).toContain("Ember");
    expect(application).toContain("Tide");
    expectNoHardcodedRanks(application);
  });

  it("B4: faqPageData without ranks keeps the static null-state bytes", () => {
    expect(faqPageData(APP_URL)).toEqual({ appUrl: APP_URL, faqs: FAQS });
  });

  it("B5: aboutPageData derives the ladder fact from ranks", () => {
    const { facts } = liveAboutPageData(APP_URL, LIVE_RANKS);
    const ladder = aboutFact(facts, "No application, no interview");
    expect(ladder).toContain("Ember");
    expect(ladder).toContain("Tide");
    expect(ladder).toContain("The ladder records trust and time, not grind.");
    expectNoHardcodedRanks(ladder);
  });

  it("B6: aboutPageData without ranks keeps the static null-state bytes", () => {
    expect(aboutPageData(APP_URL)).toEqual({
      appUrl: APP_URL,
      strap: ABOUT_STRAP,
      lead: ABOUT_LEAD,
      facts: ABOUT_FACTS,
    });
  });

  it("B7: faqPageData derives the unclaimed claim from a zero top rung", () => {
    const ranks = LIVE_RANKS.map((rank) =>
      rank.key === "crown" ? { ...rank, memberCount: 0 } : rank,
    );
    const { faqs } = liveFaqPageData(APP_URL, ranks);
    expect(faqAnswer(faqs, "What are the rank rungs?")).toContain("Crown is still unclaimed");
  });

  it("B8: faqPageData never claims unclaimed for an unknown top rung", () => {
    const ranks = LIVE_RANKS.map((rank) =>
      rank.key === "crown" ? { ...rank, memberCount: null } : rank,
    );
    const { faqs } = liveFaqPageData(APP_URL, ranks);
    expect(faqAnswer(faqs, "What are the rank rungs?")).not.toContain("still unclaimed");
  });
});

describe("web_v1 rank data: Kit home SSR render", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
  };

  const APP_URL = "https://example.test";
  const INVITE_URL = "https://discord.gg/invite";

  let renderPage: (data: Record<string, unknown>) => string;
  let scratch = "";

  function baseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      session: null,
      sessionUnavailable: false,
      notice: null,
      joinResult: null,
      inviteUrl: INVITE_URL,
      appUrl: APP_URL,
      counts: { memberCount: 84, onlineCount: 12, ranks: LIVE_RANKS },
      upcomingEvents: [],
      eventsUnavailable: false,
      featured: [],
      imageHosts: "",
      homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS: NULL_STATE_RANKS },
      ...overrides,
    };
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "kit-rank-live-render-"));
    const entry = join(scratch, "kit-rank-live-render-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-rank-live-render-bundle.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib/") },
      plugins: [
        {
          name: "kit-rank-live-render-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
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
    const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
      renderPage: (data: Record<string, unknown>) => string;
    };
    renderPage = mod.renderPage;
  }, 60000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("B1: Kit ladder heading, rows and roles render from live ranks", () => {
    const html = renderPage(baseData());
    const ladder = ladderSection(html);
    expect(ladder).toContain(`<h2>${LIVE_ORDER}</h2>`);
    const pairs = compact(ladder);
    expect(pairs).toContain("<dt>Ember</dt><dd>24</dd>");
    expect(pairs).toContain("<dt>Stone</dt><dd>unclaimed</dd>");
    expect(pairs).toContain("<dt>Thorn</dt><dd></dd>");
    for (const [key, roleId] of Object.entries(LIVE_ROLE_IDS)) {
      expect(rankCard(ladder, key)).toContain(`data-role-id="${roleId}"`);
    }
    expect(rankCard(ladder, "thorn")).not.toContain("data-role-id");
    expectNoHardcodedRanks(html);
    expect(html).not.toContain(STATIC_STACK_SENTENCE);
  });

  it("B2: Kit null-state keeps the static ladder when ranks are empty", () => {
    const html = renderPage(
      baseData({ counts: { memberCount: null, onlineCount: null, ranks: [] } }),
    );
    expect(html).toContain('data-testid="rank-stack"');
    const pairs = compact(ladderSection(html));
    for (const rank of HARDCODED_RANK_NAMES) {
      expect(pairs).toContain(`<dt>${rank}</dt><dd></dd>`);
    }
  });
});
