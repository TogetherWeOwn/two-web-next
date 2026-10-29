// Acceptance oracle: featured title/body/image_alt reject control, bidi and
// invisible characters exactly like the event form.
//
// The event form refuses these on raw submitted text via the shared
// containsControlCharacters oracle (src/admin/validation-shared.ts), allowing
// tab/LF/CR and genuine emoji ZWJ sequences, with the copy "Remove control or
// invisible characters." The featured form today rejects only NUL per field
// (src/admin/validation-featured-form.ts, "Only NUL is rejected in this
// slice"), so a bidi-override or zero-width payload in a featured headline
// reaches the homepage slot while the identical payload is 422 on events.
//
// Contract notes for the implementer (Builder):
// - Title, body and image_alt must reject with the EXACT event-form copy
//   "Remove control or invisible characters.", checked on the RAW submitted
//   text (trim hides a leading BOM). The copy is pinned literally, on both
//   the validator and the 422 HTML, so moderator-facing wording stays single.
// - NUL is the one wording exception: it is already rejected with
//   field-specific copy ("Headline/Body/Alt text cannot contain NUL
//   characters."). These tests pin NUL as rejected-with-a-non-empty-message
//   on the offending field only, so the Builder may keep the NUL-specific
//   copy or unify it onto the event copy without breaking this suite.
// - A single offending field must be the ONLY error: no collateral broadening.
// - Lone surrogates are ADMITTED, matching the oracle (containsControlCharacters
//   returns false for them): this suite pins parity, not a new surrogate rule.
//   They are validator-only pins: URL-encoding replaces a lone surrogate with
//   U+FFFD before the server sees it, so no route test can deliver one.
// - Genuine emoji ZWJ sequences, tab/LF/CR and all server-valid Unicode still
//   pass verbatim; length caps (255/255/1000), trimming, empty-null behavior,
//   URL/host admission and NUL rejection are unchanged.
// - Both Hono and Kit new/edit paths enforce identically through the single
//   shared validator. Kit forms POST to the Hono controllers (the Kit
//   +page.server.ts files carry loads only), so the Kit proofs derive the
//   POST destinations from the .svelte sources and post there: if Kit ever
//   stops posting to Hono, the suite follows it instead of silently passing.
// - Machine ingress has no featured path; its behavior is unchanged by
//   construction (no featured branch exists in src/agent-events).
//
// Intentional existing-suite contract change: the Builder must update the one
// control in test/admin-featured-nul-rejection.test.ts that pins BEL as
// accepted in the featured body ("only NUL is rejected"). Every other NUL,
// length and parity assertion stays green.
//
// Hermetic: pure validator pins (no DB), Kit-markup pins (no DB), and the real
// adminApp create/edit handlers over an owned disposable-test-database schema
// (skipped without DATABASE_URL). Synthetic rows only; never production or
// staging data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  containsControlCharacters,
  parseFeaturedForm,
  ValidationError,
} from "../src/admin/validation";
import { activityLog, events, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { featuredBaselineFields } from "./helpers/featured-baseline";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// The event-form copy (src/admin/validation-event-form.ts). Pinned literally:
// moderator-facing refusal wording stays single across forms.
const EVENT_COPY = "Remove control or invisible characters.";

// Special characters as explicit code points (never literal bytes: C0 controls
// are invisible in diffs and lone surrogates do not survive UTF-8 transport).
const NUL = String.fromCodePoint(0x00);
const BEL = String.fromCodePoint(0x07);
const VT = String.fromCodePoint(0x0b);
const US = String.fromCodePoint(0x1f);
const DEL = String.fromCodePoint(0x7f);
const NEL = String.fromCodePoint(0x85);
const BIDI_EMBED = String.fromCodePoint(0x202a);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const BIDI_ISOLATE_OPEN = String.fromCodePoint(0x2066);
const BIDI_ISOLATE_CLOSE = String.fromCodePoint(0x2069);
const ZWSP = String.fromCodePoint(0x200b);
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const BOM = String.fromCodePoint(0xfeff);
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const LOW_SURROGATE = String.fromCharCode(0xdc00);
const COMBINING_ACUTE = String.fromCodePoint(0x301);
// Woman technologist: emoji + ZWJ + emoji (a genuine ZWJ sequence the oracle admits).
const ZWJ_EMOJI = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
const ASTRAL = String.fromCodePoint(0x1f600);

const base = {
  title: "Game night",
  body: "Bring a friend",
  image_url: "https://cdn.discordapp.com/photo.png",
  image_alt: "Players together",
};

const freeTextFields = [
  { input: "title", output: "title" },
  { input: "body", output: "body" },
  { input: "image_alt", output: "imageAlt" },
] as const;

// Representatives of every class the event form refuses, except NUL (which
// keeps its own wording pin below). Embedded mid-word so the character itself
// -- never trimming or length -- decides the verdict.
const FORBIDDEN = [
  { label: "BEL U+0007", char: BEL },
  { label: "vertical tab U+000B", char: VT },
  { label: "unit separator U+001F", char: US },
  { label: "DEL U+007F", char: DEL },
  { label: "C1 NEL U+0085", char: NEL },
  { label: "bidi embed U+202A", char: BIDI_EMBED },
  { label: "bidi override U+202E", char: BIDI_OVERRIDE },
  { label: "bidi isolate U+2066", char: BIDI_ISOLATE_OPEN },
  { label: "bidi isolate U+2069", char: BIDI_ISOLATE_CLOSE },
  { label: "zero-width space U+200B", char: ZWSP },
  { label: "zero-width non-joiner U+200C", char: ZWNJ },
  { label: "lone zero-width joiner U+200D", char: ZWJ },
  { label: "BOM U+FEFF", char: BOM },
] as const;
const forbiddenValue = (char: string) => `Che${char}ss`;

function featuredErrors(data: Record<string, unknown>): Record<string, string> | null {
  try {
    parseFeaturedForm(data);
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
}

function expectOnlyEventCopy(data: Record<string, unknown>, field: string): void {
  const fields = featuredErrors(data);
  expect(fields, "expected featured validation to fail").not.toBeNull();
  expect(Object.keys(fields!)).toEqual([field]);
  expect(fields![field]).toBe(EVENT_COPY);
}

function expectOnlyFieldError(data: Record<string, unknown>, field: string): void {
  const fields = featuredErrors(data);
  expect(fields, "expected featured validation to fail").not.toBeNull();
  expect(Object.keys(fields!)).toEqual([field]);
  expect(typeof fields![field]).toBe("string");
  expect(fields![field]!.length).toBeGreaterThan(0);
}

describe("featured form rejects control and invisible characters with the event copy (validator)", () => {
  for (const { input } of freeTextFields) {
    describe(input, () => {
      it.each(FORBIDDEN)("rejects $label with the event copy on that field only", ({ char }) => {
        expectOnlyEventCopy({ ...base, [input]: forbiddenValue(char) }, input);
      });

      it.each([
        { label: "leading bidi override", value: `${BIDI_OVERRIDE}Game night` },
        { label: "trailing bidi override", value: `Game night${BIDI_OVERRIDE}` },
        { label: "bidi override only", value: BIDI_OVERRIDE },
        { label: "leading zero-width space", value: `${ZWSP}Game night` },
        { label: "trailing zero-width space", value: `Game night${ZWSP}` },
        { label: "zero-width space only", value: ZWSP },
        { label: "lone ZWJ only", value: ZWJ },
        { label: "leading DEL", value: `${DEL}Game night` },
        { label: "embedded C1", value: `Game${NEL}night` },
      ])("rejects a $label with the event copy", ({ value }) => {
        expectOnlyEventCopy({ ...base, [input]: value }, input);
      });

      it.each([
        // trimHides marks the cases where trim() strips the BOM, so a
        // trimmed-only check would admit them: the verdict must come from the
        // raw submitted text. An embedded BOM survives trim either way.
        { label: "leading BOM", value: `${BOM}Game night`, trimHides: true },
        { label: "trailing BOM", value: `Game night${BOM}`, trimHides: true },
        { label: "embedded BOM", value: `Game${BOM}night`, trimHides: false },
        { label: "BOM only", value: BOM, trimHides: true },
        { label: "BOM behind whitespace", value: ` ${BOM}Game night`, trimHides: true },
        { label: "BOM with trailing whitespace", value: `Game night${BOM} `, trimHides: true },
      ])(
        "rejects a $label with the event copy (raw text, trim hides BOM)",
        ({ value, trimHides }) => {
          if (trimHides) expect(value.trim()).not.toContain(BOM);
          else expect(value.trim()).toContain(BOM);
          expectOnlyEventCopy({ ...base, [input]: value }, input);
        },
      );
    });
  }

  it("reports every offending free-text field when several carry controls", () => {
    const fields = featuredErrors({
      ...base,
      title: forbiddenValue(BIDI_OVERRIDE),
      body: forbiddenValue(ZWSP),
      image_alt: forbiddenValue(BEL),
    });
    expect(Object.keys(fields!).sort()).toEqual(["body", "image_alt", "title"]);
    for (const message of Object.values(fields!)) expect(message).toBe(EVENT_COPY);
  });

  it("rejects a control in image_alt even when no image URL makes it required", () => {
    expectOnlyEventCopy(
      { title: "Game night", body: "Bring a friend", image_alt: forbiddenValue(BIDI_OVERRIDE) },
      "image_alt",
    );
  });

  it("rejects a 255-code-point title whose last character is a bidi override (length alone passes)", () => {
    expectOnlyEventCopy({ ...base, title: `${"x".repeat(254)}${BIDI_OVERRIDE}` }, "title");
  });

  it("rejects a 255-code-point image_alt whose last character is zero-width (length alone passes)", () => {
    expectOnlyEventCopy({ ...base, image_alt: `${"x".repeat(254)}${ZWSP}` }, "image_alt");
  });

  it("keeps NUL rejected on the offending field only (wording free: NUL-specific or event copy)", () => {
    for (const { input } of freeTextFields) {
      expectOnlyFieldError({ ...base, [input]: `before${NUL}after` }, input);
    }
    const fields = featuredErrors({
      ...base,
      title: `before${NUL}after`,
      body: `before${NUL}after`,
      image_alt: `before${NUL}after`,
    });
    expect(Object.keys(fields!).sort()).toEqual(["body", "image_alt", "title"]);
  });
});

// The validator must agree with the shared oracle on every sample: featured
// cannot refuse what the event form admits, nor admit what it refuses. Lone
// surrogates are the admit side of this pin (the oracle returns false).
describe("featured validator agrees with the shared control oracle", () => {
  const samples = [
    ...FORBIDDEN.map(({ label, char }) => ({ label, value: forbiddenValue(char) })),
    { label: "NUL U+0000", value: forbiddenValue(NUL) },
    { label: "leading BOM", value: `${BOM}Game` },
    { label: "BOM behind whitespace", value: ` ${BOM}Game` },
    { label: "tab inside", value: "Game\tnight" },
    { label: "line feed inside", value: "Game\nnight" },
    { label: "carriage return inside", value: "Game\rnight" },
    { label: "genuine emoji ZWJ sequence", value: `Hosted by ${ZWJ_EMOJI} tonight` },
    { label: "paired surrogate emoji", value: ASTRAL },
    { label: "lone high surrogate", value: `a${HIGH_SURROGATE}b` },
    { label: "lone low surrogate", value: `a${LOW_SURROGATE}b` },
    { label: "reversed lone surrogates", value: `${LOW_SURROGATE}${HIGH_SURROGATE}` },
    { label: "plain text", value: "Game night" },
    { label: "accents and CJK", value: "Café 界" },
  ] as const;

  it.each(samples)("$label: featured verdict matches containsControlCharacters", ({ value }) => {
    const oracleSaysForbidden = containsControlCharacters(value);
    for (const { input, output } of freeTextFields) {
      const fields = featuredErrors({ ...base, [input]: value });
      if (oracleSaysForbidden) {
        expect(fields, `${input} must refuse ${JSON.stringify(value)}`).not.toBeNull();
        expect(Object.keys(fields!)).toEqual([input]);
      } else {
        expect(fields, `${input} must admit ${JSON.stringify(value)}`).toBeNull();
        expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
      }
    }
  });

  it("the oracle itself admits lone surrogates and genuine ZWJ while refusing lone ZWJ", () => {
    expect(containsControlCharacters(`a${HIGH_SURROGATE}b`)).toBe(false);
    expect(containsControlCharacters(`a${LOW_SURROGATE}b`)).toBe(false);
    expect(containsControlCharacters(`Hosted by ${ZWJ_EMOJI} tonight`)).toBe(false);
    expect(containsControlCharacters(`a${ZWJ}b`)).toBe(true);
    expect(containsControlCharacters(` ${BOM}Game`)).toBe(true);
    expect(containsControlCharacters(` ${BOM}Game`.trim())).toBe(false);
  });
});

describe("featured form keeps accepting valid text (validator controls)", () => {
  for (const { input, output } of freeTextFields) {
    it(`accepts an emoji ZWJ sequence in ${input} verbatim`, () => {
      const value = `Hosted by ${ZWJ_EMOJI} tonight`;
      expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
    });

    it(`accepts tab, LF and CR inside ${input} verbatim`, () => {
      const value = "line one\nline two\r\nline three\twith a tab";
      expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
    });

    it(`accepts normal Unicode (accents, CJK, combining marks) in ${input} verbatim`, () => {
      const value = `Café 界 e${COMBINING_ACUTE} — all welcome`;
      expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
    });

    it(`accepts lone surrogates in ${input} verbatim, like the event oracle`, () => {
      for (const value of [`a${HIGH_SURROGATE}b`, `a${LOW_SURROGATE}b`]) {
        expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
      }
    });
  }

  it("still accepts exactly 255 code points of astral title text", () => {
    const title = ASTRAL.repeat(255);
    expect(parseFeaturedForm({ ...base, title }).title).toBe(title);
  });

  it("still accepts exactly 1000 code points of astral body text", () => {
    const body = ASTRAL.repeat(1000);
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
  });

  it("keeps the length refusals with their own copy, not the control copy", () => {
    expect(featuredErrors({ ...base, title: "x".repeat(256) })).toEqual({
      title: "Keep the headline to 255 characters.",
    });
    expect(featuredErrors({ ...base, body: "x".repeat(1001) })).toEqual({
      body: "Keep the body to 1000 characters.",
    });
    expect(featuredErrors({ ...base, image_alt: "x".repeat(256) })).toEqual({
      image_alt: "Keep the alt text to 255 characters.",
    });
  });

  it("keeps optional-empty behaviour: blank body and image_alt stay null", () => {
    const parsed = parseFeaturedForm({ title: "Game night", body: " \n\t ", image_alt: "  " });
    expect(parsed.body).toBeNull();
    expect(parsed.imageAlt).toBeNull();
  });

  it("keeps URL and image-host admission unchanged", () => {
    expect(featuredErrors({ ...base, url: "javascript:alert(1)" })).toEqual({
      url: "Link is a full http(s) URL, or empty for no link.",
    });
    expect(parseFeaturedForm({ ...base, url: "https://example.com/night" }).url).toBe(
      "https://example.com/night",
    );
  });
});

// --- Kit path derivation (no DB) -------------------------------------------
// The Kit proofs post to the destinations the Kit pages themselves name, so a
// future Kit-only submission path cannot bypass the shared validator
// silently. Today both Kit forms POST to the Hono controllers, which is the
// identical-enforcement claim under test.

function kitSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
}

const newSource = kitSource("../web/src/routes/admin/featured/new/+page.svelte");
const editSource = kitSource("../web/src/routes/admin/featured/[id]/+page.svelte");

function* liveSpans(source: string): Generator<string> {
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    const next = source.indexOf("<!--", index);
    const stop = next === -1 ? source.length : next;
    yield source.slice(index, stop);
    index = stop;
  }
}

function matchLive(source: string, pattern: RegExp): RegExpMatchArray | null {
  for (const span of liveSpans(source)) {
    const found = span.match(pattern);
    if (found) return found;
  }
  return null;
}

function saveFormAction(source: string): string {
  const plain = matchLive(source, /<form method="post" action="([^"]+)"/)?.[1];
  if (plain) return plain;
  const templated = matchLive(source, /<form method="post" action=\{`([^`]+)`\}/)?.[1];
  if (templated) return templated;
  throw new Error("Kit featured page has no plain-POST save form action");
}

const KIT_NEW_ACTION = saveFormAction(newSource);
const KIT_EDIT_ACTION_TEMPLATE = saveFormAction(editSource);

function kitEditAction(id: number): string {
  const resolved = KIT_EDIT_ACTION_TEMPLATE.replace(/\$\{[^}]+\}/, String(id));
  expect(resolved, "Kit edit action must embed the record id exactly once").not.toContain("${");
  return resolved;
}

/** Map a public /admin/... destination onto the adminApp test mount. */
function appPath(publicPath: string): string {
  expect(publicPath, "Kit featured form must post under /admin").toMatch(/^\/admin\//);
  return publicPath.slice("/admin".length);
}

describe("Kit featured forms submit raw text to the shared validator (no client bypass)", () => {
  for (const [mode, source] of [
    ["new", newSource],
    ["edit", editSource],
  ] as const) {
    it(`${mode}: the save form posts plainly to an /admin destination with no submit handler`, () => {
      const action = mode === "new" ? KIT_NEW_ACTION : kitEditAction(7);
      expect(action).toMatch(/^\/admin\/featured/);
      // A submit handler could strip controls client-side and bypass the
      // shared validator with a silently cleaned value.
      expect(matchLive(source, /onsubmit/)).toBeNull();
    });
  }

  it("both Kit save destinations are the Hono featured controllers under test", () => {
    expect(KIT_NEW_ACTION).toBe("/admin/featured");
    expect(kitEditAction(7)).toBe("/admin/featured/7");
  });
});

// --- Route boundary: 422 field copy, no row, no audit, no cache retire. ------

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(
  store: ReturnType<typeof createMemorySessionStore>,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "featured control/invisible create/edit boundary (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore(() => Date.now());
    const modId = "100000000000000111";
    let cookie = "";
    const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
    const app = () => adminApp({ sessionStore: store, db });
    const form = (fields: Record<string, string>) => ({
      method: "POST" as const,
      headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    const seed = (overrides: Record<string, unknown> = {}) =>
      db
        .insert(featuredContents)
        .values({
          title: "Original slot",
          body: "Original body",
          url: null,
          imageUrl: "https://cdn.discordapp.com/photo.png",
          imageAlt: "Original alt",
          isPublished: false,
          position: 4,
          startsAt: null,
          endsAt: null,
          ...overrides,
        })
        .returning();

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(() => fixture?.dispose());

    beforeEach(async () => {
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
      await db.delete(featuredContents);
      __resetHomeGuestCacheForTests();
      cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
    });

    // One representative per refused class: C0 control, bidi, zero-width, BOM.
    // NUL's route boundary already belongs to admin-featured-nul-rejection.
    const routeControls = [
      { label: "BEL", char: BEL },
      { label: "bidi override", char: BIDI_OVERRIDE },
      { label: "zero-width space", char: ZWSP },
      { label: "BOM", char: BOM },
    ] as const;

    async function expectCreateRefused(
      path: string,
      fields: Record<string, string>,
      preserved: string,
    ): Promise<void> {
      const res = await app().request(path, form(fields), liveEnv());
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(html).toContain(EVENT_COPY);
      expect(html).toContain(preserved);
      expect(await db.select().from(featuredContents)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toEqual([]);
    }

    describe("Hono create path (POST /featured)", () => {
      for (const { label, char } of routeControls) {
        it(`422s a ${label} in the title with the event copy, no row and no audit`, async () => {
          await expectCreateRefused(
            "/featured",
            { title: forbiddenValue(char), body: "Kept draft body", position: "0" },
            "Kept draft body",
          );
        });

        it(`422s a ${label} in the body with the event copy, no row and no audit`, async () => {
          await expectCreateRefused(
            "/featured",
            { title: "Kept draft title", body: forbiddenValue(char), position: "0" },
            "Kept draft title",
          );
        });

        it(`422s a ${label} in image_alt with the event copy, no row and no audit`, async () => {
          await expectCreateRefused(
            "/featured",
            {
              title: "Kept draft title",
              image_url: "https://cdn.discordapp.com/photo.png",
              image_alt: forbiddenValue(char),
              position: "0",
            },
            "Kept draft title",
          );
        });
      }

      it("422s a BOM behind whitespace in the title (raw text, trim hides BOM)", async () => {
        await expectCreateRefused(
          "/featured",
          { title: ` ${BOM}Game night`, body: "Kept draft body", position: "0" },
          "Kept draft body",
        );
      });
    });

    describe("Hono edit path (POST /featured/:id)", () => {
      for (const { label, char } of routeControls) {
        it(`422s a ${label} in the title and leaves the row unchanged, with no audit`, async () => {
          const [seeded] = await seed();
          const id = seeded!.id;
          const res = await app().request(
            `/featured/${id}`,
            form({
              ...(await featuredBaselineFields(db, id)),
              title: forbiddenValue(char),
              body: "Original body",
              image_url: "https://cdn.discordapp.com/photo.png",
              image_alt: "Original alt",
              position: "4",
            }),
            liveEnv(),
          );
          expect(res.status).toBe(422);
          const html = await res.text();
          expect(html).toContain('data-testid="form-errors"');
          expect(html).toContain(EVENT_COPY);
          const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
          expect(row).toMatchObject({
            title: "Original slot",
            body: "Original body",
            imageAlt: "Original alt",
          });
          expect(await db.select().from(activityLog)).toEqual([]);
        });

        it(`422s a ${label} in the body and leaves the row unchanged, with no audit`, async () => {
          const [seeded] = await seed();
          const id = seeded!.id;
          const res = await app().request(
            `/featured/${id}`,
            form({
              ...(await featuredBaselineFields(db, id)),
              title: "Original slot",
              body: forbiddenValue(char),
              position: "4",
            }),
            liveEnv(),
          );
          expect(res.status).toBe(422);
          expect(await res.text()).toContain(EVENT_COPY);
          const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
          expect(row).toMatchObject({ title: "Original slot", body: "Original body" });
          expect(await db.select().from(activityLog)).toEqual([]);
        });

        it(`422s a ${label} in image_alt and leaves the row unchanged, with no audit`, async () => {
          const [seeded] = await seed();
          const id = seeded!.id;
          const res = await app().request(
            `/featured/${id}`,
            form({
              ...(await featuredBaselineFields(db, id)),
              title: "Original slot",
              body: "Original body",
              image_url: "https://cdn.discordapp.com/photo.png",
              image_alt: forbiddenValue(char),
              position: "4",
            }),
            liveEnv(),
          );
          expect(res.status).toBe(422);
          expect(await res.text()).toContain(EVENT_COPY);
          const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
          expect(row).toMatchObject({ imageAlt: "Original alt" });
          expect(await db.select().from(activityLog)).toEqual([]);
        });
      }
    });

    describe("Kit paths enforce identically to Hono", () => {
      for (const { label, char } of routeControls) {
        it(`Kit new refuses a ${label} in the title with the oracle 422 and persists nothing`, async () => {
          await expectCreateRefused(
            appPath(KIT_NEW_ACTION),
            { title: forbiddenValue(char), body: "Kept draft body", position: "0" },
            "Kept draft body",
          );
        });

        it(`Kit edit refuses a ${label} in the body with the oracle 422 and leaves the row untouched`, async () => {
          const [seeded] = await seed();
          const res = await app().request(
            appPath(kitEditAction(seeded!.id)),
            form({
              ...(await featuredBaselineFields(db, seeded!.id)),
              title: "Original slot",
              body: forbiddenValue(char),
              position: "4",
            }),
            liveEnv(),
          );
          expect(res.status).toBe(422);
          expect(await res.text()).toContain(EVENT_COPY);
          const [row] = await db
            .select()
            .from(featuredContents)
            .where(eq(featuredContents.id, seeded!.id));
          expect(row).toMatchObject({ title: "Original slot", body: "Original body" });
          expect(await db.select().from(featuredContents)).toHaveLength(1);
        });
      }

      it("Kit edit refuses a BOM in image_alt with the oracle 422 and leaves the row untouched", async () => {
        const [seeded] = await seed();
        const res = await app().request(
          appPath(kitEditAction(seeded!.id)),
          form({
            ...(await featuredBaselineFields(db, seeded!.id)),
            title: "Original slot",
            body: "Original body",
            image_url: "https://cdn.discordapp.com/photo.png",
            image_alt: `${BOM}Game night`,
            position: "4",
          }),
          liveEnv(),
        );
        expect(res.status).toBe(422);
        expect(await res.text()).toContain(EVENT_COPY);
        const [row] = await db
          .select()
          .from(featuredContents)
          .where(eq(featuredContents.id, seeded!.id));
        expect(row).toMatchObject({ imageAlt: "Original alt" });
      });
    });

    describe("refusals retire no homepage cache", () => {
      it("a 422 create leaves the warmed featured cache serving pre-refusal bytes", async () => {
        await seed({ isPublished: true });
        const warmed = await cachedFeatured(liveEnv(), async () => db);
        expect(warmed).toHaveLength(1);

        const res = await app().request(
          "/featured",
          form({ title: forbiddenValue(BIDI_OVERRIDE), body: "Kept draft body", position: "0" }),
          liveEnv(),
        );
        expect(res.status).toBe(422);

        let dbReads = 0;
        const after = await cachedFeatured(liveEnv(), async () => {
          dbReads += 1;
          return db;
        });
        expect(after).toHaveLength(1);
        expect(after[0]!.title).toBe("Original slot");
        expect(dbReads).toBe(0);
      });

      it("a valid 303 create retires the cache (the proof above can detect a retire)", async () => {
        await seed({ isPublished: true });
        expect(await cachedFeatured(liveEnv(), async () => db)).toHaveLength(1);

        const res = await app().request(
          "/featured",
          form({ title: "Second slot", body: "Fresh body", position: "1", is_published: "on" }),
          liveEnv(),
        );
        expect(res.status).toBe(303);

        let dbReads = 0;
        const after = await cachedFeatured(liveEnv(), async () => {
          dbReads += 1;
          return db;
        });
        expect(dbReads).toBe(1);
        expect(after).toHaveLength(2);
      });
    });

    describe("valid text still creates through both paths (controls)", () => {
      it("creates emoji-ZWJ + tabbed content with a 303, the stored row and its audit", async () => {
        const fields = {
          title: `Hosted by ${ZWJ_EMOJI} tonight`,
          body: "line one\nline two\r\nline three\twith a tab",
          image_url: "https://cdn.discordapp.com/photo.png",
          image_alt: `Hosted by ${ZWJ_EMOJI} tonight`,
          position: "0",
        };
        const res = await app().request("/featured", form(fields), liveEnv());
        expect(res.status).toBe(303);
        const id = Number(res.headers.get("location")!.split("/").pop());
        const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
        expect(row).toMatchObject({ title: fields.title, body: fields.body });
        const audit = await db.select().from(activityLog);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ subjectType: "FeaturedContent", subjectId: String(id) });
      });

      it("admits the same content through the Kit new destination", async () => {
        const fields = {
          title: `Hosted by ${ZWJ_EMOJI} tonight`,
          body: "Café 界 — all welcome",
          position: "0",
        };
        const res = await app().request(appPath(KIT_NEW_ACTION), form(fields), liveEnv());
        expect(res.status).toBe(303);
        const id = Number(res.headers.get("location")!.split("/").pop());
        const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
        expect(row).toMatchObject({ title: fields.title, body: fields.body });
      });
    });
  },
);
