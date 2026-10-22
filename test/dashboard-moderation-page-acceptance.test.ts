// route-inventory: GET /admin/moderation, POST /admin/moderation
// Acceptance: dashboard moderation page (Slice 2b).
//
// Parent spec: "Web dashboard parity" §2.1 (moderation slice),
// §3 (data model), §3.5 (conflicts), §4 (security), §6 (test plan), §7 item 6,
// owner decisions B4 (write auth) + B7 (honest gaps). Owner-approved 2026-10-21.
//
// Locked contract (the paired Builder satisfies this file WITHOUT editing it;
// corrections go back to the Code Reviewer agent, never a Builder edit):
//
// - GET /admin/moderation sits behind the shared admin guard (guest OAuth
//   bounce, signed non-moderator 403) and renders the moderation shell:
//   an editable hot-keys form over the EXISTING settings.get/settings.set
//   path, a read-only status panel for EnvOnly keys, and explicit
//   "not available" states for warn/strike escalation and mute-role config,
//   which do not exist in the bot and are never invented.
// - Hot keys are dashboard-writable with optimistic concurrency: the form
//   carries the live value + version, the write sends the expected version,
//   a stale version answers 409 with a re-read prompt, and every mutation
//   is attributed (dashboard:<user-id>) and audited exactly once.
// - Writes travel the existing signed internal-action path (spec §4.3):
//   queue-carried, UUID idempotency key per dispatch, no new tokens, no
//   dashboard-to-Postgres direct path. Reads reuse settings.get; the bot
//   response shape pinned here follows spec §3.1 guild_settings columns
//   (key/value/version/updated_by/updated_at) inside the established
//   {ok:true,result:{settings:[...]}} envelope (cf. event.read). If the live
//   bot envelope differs, the Builder surfaces the mismatch on the card and
//   the Test Author amends this file — the Builder never "adapts" the test.
// - Write auth (B4): dashboard admin session AND a live Discord role check
//   at write time, strictly scoped to the session guild. Reads use the
//   session bit only: no per-click Discord dependency on GET.
// - EnvOnly keys (spec §3.1: TWO_MODERATION master, protected IDs,
//   TWO_OWEN_USER_ID, TWO_INTERNAL_*, assistant/synthetic IDs) are
//   read-only status: visible, never submittable, forged writes refused
//   before anything is dispatched.
// - Audit retention bound is set before ship: every successful write leaves
//   exactly one attributable activity_log row, and the retention ledger
//   names the moderation audit bound (doc + ledger test together).
//
// What this file pins by full name (spec-verbatim): TWO_AUTOMOD_MENTION_LIMIT
// (spec §6 live check) end to end; TWO_MODERATION (spec §3.1/B5) read-only.
// Family coverage (TWO_RAID_*, TWO_JOIN_RISK_*, TWO_ANTI_NUKE_*,
// *_LOG_CHANNEL_ID) is a source pin: the real key names live in two-bot-next
// and per-key liveness is proven by the staging live-check in spec §6, not
// by invented fixture names here.
//
// RED until the Builder ships the page: all but the two shared-guard
// controls fail with 404 (route missing), every offline pin fails on absent
// content. Failure for any other reason (typo, harness error) is a bug in
// this file.
import { readdirSync, readFileSync } from "node:fs";
import { parseSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { activityLog } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { LOGIN_INTENDED_COOKIE } from "../src/return-journey";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const HOT_KEY = "TWO_AUTOMOD_MENTION_LIMIT";
const ENVONLY_KEY = "TWO_MODERATION";
const BOT_URL = "https://bot.moderation-fixture.test";
const MOD_ROLE = "555000000000000001";
const OTHER_GUILD = "999000000000000999";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function srcFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
}

describe("moderation page static pins (offline)", () => {
  it("the retention ledger names the moderation audit bound before ship", () => {
    const ledger = readFileSync("docs/retention-ledger.md", "utf8");
    expect(ledger).toMatch(/moderation/i);
    // The bound travels with the row: one ledger line names moderation and
    // its window together, so a later prune change cannot silently orphan it.
    const row = ledger
      .split(/\r?\n/)
      .find(
        (line) =>
          /moderation/i.test(line) &&
          /(\d+\s*(days?|weeks?|months?|years?)|indefinite|retain)/i.test(line),
      );
    expect(row, "ledger row binding moderation audit to a retention window").toBeDefined();
  });

  it("the retention ledger test pins the moderation row with the doc", () => {
    // Ledger convention: no window or mechanism changes without changing the
    // code and the test together.
    expect(readFileSync("test/retention-ledger.test.ts", "utf8")).toMatch(/moderation/i);
  });

  it.each(["settings.get", "settings.set"])(
    "the dashboard reuses the existing %s verb, inventing no new path",
    (verb) => {
      const hits = srcFiles(["src/admin/", "src/bot/"]).filter((file) =>
        readFileSync(file, "utf8").includes(verb),
      );
      expect(hits, `src file referencing ${verb}`).not.toHaveLength(0);
    },
  );

  it.each(["TWO_RAID_", "TWO_JOIN_RISK_", "TWO_ANTI_NUKE_", "LOG_CHANNEL_ID"])(
    "the moderation wiring covers the %s family, not just the one pinned key",
    (family) => {
      const hits = srcFiles(["src/admin/", "src/bot/"]).filter((file) =>
        readFileSync(file, "utf8").includes(family),
      );
      expect(hits, `src file covering ${family}`).not.toHaveLength(0);
    },
  );
});

// Test-only HTML helpers (detection, never sanitizing: presence checks plus
// the attendee suite's tag-walking text extraction, so no helper reads as an
// HTML sanitizer for CodeQL).
function textOutsideTags(fragment: string): string {
  let out = "";
  let inTag = false;
  for (const ch of fragment) {
    if (ch === "<" && !inTag) inTag = true;
    else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function sectionByTestid(html: string, testid: string): string | null {
  const m = html.match(
    new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b([^>]*data-testid="${testid}"[^>]*)>([\\s\\S]*?)</\\1>`),
  );
  return m ? m[3]! : null;
}

function inputTags(html: string): string[] {
  return html.match(/<input\b[^>]*>/gi) ?? [];
}

function inputNamed(html: string, name: string): string | null {
  const needle = `name="${name}"`;
  return inputTags(html).find((tag) => tag.includes(needle)) ?? null;
}

function hasSubmittableControls(inner: string): boolean {
  return /<\s*(input|select|textarea|button)\b/i.test(inner);
}

describe.skipIf(!process.env.DATABASE_URL)(
  "dashboard moderation page acceptance (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let sessions: SessionStore;
    const sent: unknown[] = [];
    const botCalls: Array<{ url: string; body: string }> = [];
    // The stub answers settings.get from this canned guild_settings-shaped
    // data (spec §3.1 columns). Fixed versions keep the stale-version tests
    // deterministic: live reads must still hit the bot on every request.
    const stubState = {
      settings: [
        {
          key: HOT_KEY,
          value: "5",
          version: 7,
          updated_by: "discord:/automod",
          updated_at: "2026-10-20T12:00:00.000Z",
        },
        {
          key: ENVONLY_KEY,
          value: "on",
          version: 3,
          updated_by: "operator:deploy",
          updated_at: "2026-10-19T08:00:00.000Z",
        },
      ],
      discordRoles: [MOD_ROLE] as string[],
      discordDown: false,
      botDown: false,
    };
    const realFetch = globalThis.fetch;

    const bindings = () =>
      ({
        ...env,
        ADMIN_DB: fixture.db,
        INTERNAL_ACTION_QUEUE: {
          send: async (message: unknown) => {
            sent.push(message);
            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
          },
        },
        BOT_ENDPOINT_URL: BOT_URL,
        BOT_KEY_ID: "fixture-key-id",
        BOT_SHARED_SECRET: "fixture-secret-not-a-credential",
        DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
      }) as unknown as Env;
    const admin = () => adminApp({ sessionStore: sessions, db: fixture.db });
    const get = (path: string, cookie?: string) =>
      admin().request(path, { method: "GET", headers: cookie ? { cookie } : {} }, bindings());
    const postForm = (cookie: string, params: Record<string, string>) =>
      admin().request(
        "/moderation",
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(params),
        },
        bindings(),
      );
    const audits = () => fixture.db.select().from(activityLog);

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      await fixture.reset();
      sessions = createMemorySessionStore();
      sent.length = 0;
      botCalls.length = 0;
      stubState.discordRoles = [MOD_ROLE];
      stubState.discordDown = false;
      stubState.botDown = false;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === BOT_URL || url.startsWith(`${BOT_URL}/`)) {
          const body = String(init?.body ?? "");
          botCalls.push({ url, body });
          if (stubState.botDown) return new Response("bot down", { status: 500 });
          if (body.includes("settings.get")) {
            return new Response(
              JSON.stringify({ ok: true, result: { settings: stubState.settings } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ ok: false, code: "unknown_verb" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("https://discord.com/api/v10/guilds/")) {
          if (stubState.discordDown) return new Response("discord down", { status: 500 });
          return new Response(JSON.stringify({ roles: stubState.discordRoles, joined_at: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return realFetch(input as RequestInfo | URL, init);
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
    });
    afterAll(() => fixture?.dispose());

    function expectSettingsSetDispatch(
      msg: unknown,
      want: { key: string; value: string; version: number },
    ): void {
      const s = JSON.stringify(msg);
      // Verb naming is tolerant (kind/action/verb all acceptable); the
      // security facts below are exact.
      expect(s).toMatch(/settings\.set|settings:set|settings-set|settings_set/i);
      expect(s).toContain(want.key);
      expect(s).toContain(want.value);
      expect(s).toMatch(
        new RegExp(`"(expected_version|expectedVersion|version)"\\s*:\\s*"?${want.version}"?`),
      );
      // Spec §3.5 attribution: dashboard writes carry dashboard:<user-id>.
      expect(s).toContain(`dashboard:${MODERATOR.userId}`);
      // Single-guild site: the dispatched guild is always the session guild.
      expect(s).toContain(env.DISCORD_GUILD_ID);
      const record = msg as Record<string, unknown>;
      const nested = record["action"] as Record<string, unknown> | undefined;
      const key =
        record["idempotencyKey"] ??
        record["idempotency_key"] ??
        nested?.["idempotencyKey"] ??
        nested?.["idempotency_key"];
      expect(key, "UUID idempotency key on the mutating dispatch").toMatch(UUID_RE);
    }

    it("the dashboard index links the moderation section", async () => {
      const res = await get("/", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('href="/admin/moderation"');
    });

    it("a guest bounces to OAuth with the moderation page as the return (control: shared guard)", async () => {
      const res = await get("/moderation");
      expect(res.status).toBe(302);
      expect(res.headers.get("location") ?? "").toContain("/auth/discord");
      // Hono keeps the return in the signed intended cookie (Kit uses ?next=).
      const pair =
        res.headers
          .getSetCookie()
          .find((c) => c.startsWith(`${LOGIN_INTENDED_COOKIE}=`))
          ?.split(";")[0] ?? null;
      expect(pair, "intended cookie").not.toBeNull();
      const decoded = await parseSigned(pair!, env.SESSION_SECRET, LOGIN_INTENDED_COOKIE);
      expect(decoded[LOGIN_INTENDED_COOKIE] ?? "").toContain("moderation");
    });

    it("a signed non-moderator is forbidden, never bounced into a login loop (control: shared guard)", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MEMBER));
      expect(res.status).toBe(403);
    });

    it("a moderator renders the page from a live settings.get read", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      expect(
        botCalls.some((call) => call.body.includes("settings.get")),
        "page reads live settings via settings.get",
      ).toBe(true);
      expect(await audits()).toHaveLength(0);
    });

    it("the hot-keys form carries the live value plus its expected version", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/<form\b[^>]*action="[^"]*moderation[^"]*"[^>]*>/i);
      const field = inputNamed(html, HOT_KEY);
      expect(field, `editable ${HOT_KEY} field`).not.toBeNull();
      expect(field).toContain('value="5"');
      expect(field).not.toMatch(/disabled|readonly/i);
      const version = inputNamed(html, "expected_version");
      expect(version, "expected_version field").not.toBeNull();
      expect(version).toContain('value="7"');
    });

    it("last-changed-by/at comes from the audit trail, not from thin air", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      const html = await res.text();
      const panel = sectionByTestid(html, "moderation-last-changed");
      expect(panel, "last-changed display").not.toBeNull();
      const text = textOutsideTags(panel!).replace(/\s+/g, " ");
      expect(text).toContain("discord:/automod");
      expect(text).toContain("2026-10-20");
    });

    it("EnvOnly keys show read-only status with no submittable control", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      const html = await res.text();
      const panel = sectionByTestid(html, "moderation-envonly-status");
      expect(panel, "EnvOnly status panel").not.toBeNull();
      expect(textOutsideTags(panel!).replace(/\s+/g, " ")).toContain(ENVONLY_KEY);
      expect(hasSubmittableControls(panel!)).toBe(false);
    });

    it("warn/strike escalation shows not available with nothing to submit", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      const html = await res.text();
      const section = sectionByTestid(html, "moderation-escalation-unavailable");
      expect(section, "escalation unavailable section").not.toBeNull();
      expect(section!).toMatch(/not available/i);
      expect(hasSubmittableControls(section!)).toBe(false);
    });

    it("mute-role config shows not available with nothing to submit", async () => {
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      const html = await res.text();
      const section = sectionByTestid(html, "moderation-mute-role-unavailable");
      expect(section, "mute-role unavailable section").not.toBeNull();
      expect(section!).toMatch(/not available/i);
      expect(hasSubmittableControls(section!)).toBe(false);
    });

    it("reads never gate on Discord availability", async () => {
      stubState.discordDown = true;
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(HOT_KEY);
    });

    it("a hot-key write dispatches settings.set, attributed and audited once", async () => {
      const res = await postForm(await cookieFor(sessions, MODERATOR), {
        [HOT_KEY]: "8",
        expected_version: "7",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location") ?? "").toContain("moderation");
      expect(sent).toHaveLength(1);
      expectSettingsSetDispatch(sent[0], { key: HOT_KEY, value: "8", version: 7 });
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ causerId: MODERATOR.userId });
      expect(JSON.stringify(rows[0])).toContain(HOT_KEY);
    });

    it("a stale expected version answers 409 with a re-read prompt, dispatching nothing", async () => {
      const res = await postForm(await cookieFor(sessions, MODERATOR), {
        [HOT_KEY]: "8",
        expected_version: "6",
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toMatch(/stale|mismatch|conflict|changed|re-read|reload/i);
      expect(sent).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    });

    it("a write without its expected version is refused before anything is sent", async () => {
      const res = await postForm(await cookieFor(sessions, MODERATOR), { [HOT_KEY]: "8" });
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(/version/i);
      expect(sent).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    });

    it("a forged EnvOnly write is refused before anything is sent", async () => {
      const res = await postForm(await cookieFor(sessions, MODERATOR), {
        [ENVONLY_KEY]: "off",
        expected_version: "3",
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(ENVONLY_KEY);
      expect(sent).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    });

    it("escalation/mute-role fields are refused: unknown settings are never written", async () => {
      const res = await postForm(await cookieFor(sessions, MODERATOR), {
        warn_escalation_policy: "three-strikes",
        mute_role_id: "555000000000000002",
        expected_version: "7",
      });
      expect(res.status).toBe(422);
      expect(sent).toHaveLength(0);
      expect(JSON.stringify(sent)).not.toMatch(/warn_escalation|mute_role/i);
      expect(await audits()).toHaveLength(0);
    });

    it.each(["abc", "-1"])(
      "a non-threshold mention limit %j is refused before anything is sent",
      async (value) => {
        const res = await postForm(await cookieFor(sessions, MODERATOR), {
          [HOT_KEY]: value,
          expected_version: "7",
        });
        expect(res.status).toBe(422);
        expect(await res.text()).toContain(HOT_KEY);
        expect(sent).toHaveLength(0);
        expect(await audits()).toHaveLength(0);
      },
    );

    it("a write re-verifies the Discord role live: revoked moderator is forbidden", async () => {
      stubState.discordRoles = [];
      const res = await postForm(await cookieFor(sessions, MODERATOR), {
        [HOT_KEY]: "8",
        expected_version: "7",
      });
      expect(res.status).toBe(403);
      expect(sent).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    });

    it("a forged guild never reaches the dispatch", async () => {
      const res = await postForm(await cookieFor(sessions, MODERATOR), {
        [HOT_KEY]: "8",
        expected_version: "7",
        guild_id: OTHER_GUILD,
      });
      // Refuse it or ignore it — but the route must exist and the forged
      // guild must never be dispatched.
      expect([303, 422, 403]).toContain(res.status);
      for (const msg of sent) {
        expect(JSON.stringify(msg)).toContain(env.DISCORD_GUILD_ID);
        expect(JSON.stringify(msg)).not.toContain(OTHER_GUILD);
      }
      expect(await audits()).toHaveLength(res.status === 303 ? 1 : 0);
    });

    it("two successive writes audit twice with distinct idempotency keys", async () => {
      const cookie = await cookieFor(sessions, MODERATOR);
      for (const value of ["8", "9"]) {
        const res = await postForm(cookie, { [HOT_KEY]: value, expected_version: "7" });
        expect(res.status).toBe(303);
      }
      expect(sent).toHaveLength(2);
      const keys = sent.map((msg) => {
        const record = msg as Record<string, unknown>;
        const nested = record["action"] as Record<string, unknown> | undefined;
        return String(
          record["idempotencyKey"] ??
            record["idempotency_key"] ??
            nested?.["idempotencyKey"] ??
            nested?.["idempotency_key"] ??
            "",
        );
      });
      expect(keys[0]).toMatch(UUID_RE);
      expect(keys[1]).toMatch(UUID_RE);
      expect(keys[0]).not.toBe(keys[1]);
      const rows = await audits();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ causerId: MODERATOR.userId });
        expect(JSON.stringify(row)).toContain(HOT_KEY);
      }
    });

    it("a bot outage answers 503 without leaking bot detail, never a 500", async () => {
      stubState.botDown = true;
      const res = await get("/moderation", await cookieFor(sessions, MODERATOR));
      expect(res.status).toBe(503);
      const cache = res.headers.get("cache-control") ?? "";
      expect(cache).toContain("no-store");
      expect(cache).toContain("private");
      expect(await res.text()).not.toContain("bot down");
    });
  },
);
