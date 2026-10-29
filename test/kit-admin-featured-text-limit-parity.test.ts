// Kit admin featured text-limit parity proof (acceptance suite).
//
// The Hono featured validator caps headline and image description at 255
// code points server-side (src/admin/validation-featured-form.ts), counting
// after trimming, and the backing columns are unbounded text — the
// validator is the only cap. This proof posts through each Kit admin
// featured path (new and edit) and records admitted-vs-divergent behavior
// against that validator as oracle: expected field errors are computed by
// running the same submitted fields through parseFeaturedForm, never by
// restating the messages here.
//
// "Kit path" means the destination the Kit page itself names: the create
// and edit POST targets are read out of the .svelte sources, so if the Kit
// forms ever stop posting to the Hono controllers this suite follows them
// to the new destination instead of silently passing against Hono. The
// route-level harness mounts adminApp without the /admin prefix, so the
// derived destination is stripped of that prefix before posting.
//
// Two kinds of divergence fail this suite:
//   - a Kit path that admits what the oracle refuses (or persists it, or
//     answers anything other than the oracle's 422 field error), and
//   - a Kit path that refuses or truncates what the oracle admits —
//     including a native maxlength on the Kit inputs, which counts UTF-16
//     units and would cut a valid 255-code-point astral value in half
//     before the server ever sees it.
// Paths that pass are regression pins; paths that fail are the fix target.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { featuredContents, events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { featuredBaselineFields } from "./helpers/featured-baseline";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const IMAGE_URL = "https://cdn.discordapp.com/attachments/board.jpg";

const envBase: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// --- Kit path derivation ---------------------------------------------------

function kitSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
}

const newSource = kitSource("../web/src/routes/admin/featured/new/+page.svelte");
const editSource = kitSource("../web/src/routes/admin/featured/[id]/+page.svelte");

// Walk the source token by token, skipping `<!--...-->` comment tokens, and
// yield each span of live markup between them. A comment ends at the first
// `-->`, so skipping its token ignores commented-out markup without ever
// building a rewritten copy of the source (no replace-based stripping).
// An unterminated comment swallows the rest of the source.
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

/** First match of `pattern` in live (non-comment) markup, or null. */
function matchLive(source: string, pattern: RegExp): RegExpMatchArray | null {
  for (const span of liveSpans(source)) {
    const found = span.match(pattern);
    if (found) return found;
  }
  return null;
}

/** First plain-POST form action in the Kit page (the save form). */
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

function kitInputTag(source: string, name: string): string {
  const tag = matchLive(source, new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
  expect(tag, `expected Kit input[name="${name}"]`).toBeDefined();
  return tag!;
}

// --- Oracle ----------------------------------------------------------------

/** Field errors the Hono validator returns for the same submitted fields. */
function oracleErrors(fields: Record<string, string>): Record<string, string> {
  try {
    parseFeaturedForm(fields);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("fixture error: the Hono validator admitted these fields");
}

/** The stored-value shape the Hono validator admits for these fields. */
function oracleAdmits(fields: Record<string, string>) {
  return parseFeaturedForm(fields);
}

// --- Fixtures --------------------------------------------------------------

const ascii = (count: number) => "x".repeat(count);
const astral = (count: number) => "😀".repeat(count);

type Fields = Record<string, string>;

const refusingFixtures: { label: string; fields: Fields; refusedKey: string }[] = [
  {
    label: "256-code-point ASCII headline",
    fields: { title: ascii(256), position: "0" },
    refusedKey: "title",
  },
  {
    label: "256-code-point astral headline (512 UTF-16 units)",
    fields: { title: astral(256), position: "0" },
    refusedKey: "title",
  },
  {
    label: "256-code-point ASCII image description",
    fields: { title: "Game night", image_url: IMAGE_URL, image_alt: ascii(256), position: "0" },
    refusedKey: "image_alt",
  },
  {
    label: "256-code-point astral image description (512 UTF-16 units)",
    fields: { title: "Game night", image_url: IMAGE_URL, image_alt: astral(256), position: "0" },
    refusedKey: "image_alt",
  },
];

const admittingFixtures: { label: string; fields: Fields }[] = [
  { label: "a short valid headline", fields: { title: "Game night", position: "0" } },
  { label: "a 255-code-point ASCII headline", fields: { title: ascii(255), position: "0" } },
  {
    label: "a 255-code-point astral headline (510 UTF-16 units)",
    fields: { title: astral(255), position: "0" },
  },
  {
    label: "a 255-code-point ASCII image description",
    fields: { title: "Game night", image_url: IMAGE_URL, image_alt: ascii(255), position: "0" },
  },
  {
    label: "a 255-code-point astral image description (510 UTF-16 units)",
    fields: { title: "Game night", image_url: IMAGE_URL, image_alt: astral(255), position: "0" },
  },
  {
    // The oracle trims before counting: 257 raw units, 255 after trim.
    label: "a headline that is 255 code points after trimming",
    fields: { title: ` ${ascii(255)} `, position: "0" },
  },
];

// --- Kit-side non-truncation pins (no DB) -----------------------------------

describe("Kit featured forms carry no native length gate", () => {
  for (const [mode, source] of [
    ["new", newSource],
    ["edit", editSource],
  ] as const) {
    it(`${mode}: headline and image-description inputs omit maxlength`, () => {
      for (const name of ["title", "image_alt"]) {
        expect(kitInputTag(source, name)).not.toMatch(/\bmaxlength\s*=/i);
      }
      // Page-wide on purpose: a native length gate anywhere on the page
      // (not just on the two named inputs) still fails this pin.
      expect(matchLive(source, /\bmaxlength\s*=/i)).toBeNull();
    });

    it(`${mode}: the save form posts plainly to an /admin destination`, () => {
      const action = mode === "new" ? KIT_NEW_ACTION : kitEditAction(7);
      expect(action).toMatch(/^\/admin\/featured/);
      expect(matchLive(source, /onsubmit/)).toBeNull();
    });
  }
});

// --- Route-level parity proof (disposable DB only) --------------------------

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
  "Kit featured paths vs the Hono 255 oracle (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore(() => Date.now());
    let cookie = "";
    const liveEnv = () => ({ ...envBase, ADMIN_DB: db }) as Env;
    const app = () => adminApp({ sessionStore: store, db });
    const post = async (publicPath: string, fields: Fields) => {
      // Edit posts submit the row's fresh saved-content baseline, the way a
      // rendered edit form carries it; creates have no saved content to pin.
      const editId = /^\/admin\/featured\/(\d+)$/.exec(publicPath)?.[1];
      return app().request(
        appPath(publicPath),
        {
          method: "POST",
          headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            ...(editId ? await featuredBaselineFields(db, Number(editId)) : {}),
            ...fields,
          }),
        },
        liveEnv(),
      );
    };
    const allRows = () => db.select().from(featuredContents);
    const seedRow = async () => {
      const [row] = await db
        .insert(featuredContents)
        .values({
          title: "Original slot",
          body: "Original body",
          url: null,
          imageUrl: IMAGE_URL,
          imageAlt: "Original description",
          isPublished: false,
          position: 0,
          startsAt: null,
          endsAt: null,
        })
        .returning();
      return row!;
    };

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(() => fixture?.dispose());

    beforeEach(async () => {
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
      await db.delete(featuredContents);
      cookie = await cookieFor(store, {
        userId: "100000000000000111",
        username: "mod",
        moderator: true,
      });
    });

    async function expectRefused(publicPath: string, fields: Fields, refusedKey: string) {
      const oracle = oracleErrors(fields);
      expect(oracle[refusedKey], "oracle must refuse this fixture on the named field").toBeTypeOf(
        "string",
      );
      const res = await post(publicPath, fields);
      expect(res.status, "overlong input must 422 through the Kit path, like Hono").toBe(422);
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(html).toContain(oracle[refusedKey]!);
      // The overlong draft is handed back whole, not truncated to the cap.
      expect(html).toContain(fields[refusedKey]!);
    }

    async function expectAdmittedNew(fields: Fields) {
      const oracle = oracleAdmits(fields);
      const res = await post(KIT_NEW_ACTION, fields);
      expect(res.status, "oracle-admitted input must be admitted through the Kit path").toBe(303);
      const id = Number(res.headers.get("location")!.split("/").pop());
      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row).toMatchObject({ title: oracle.title, imageAlt: oracle.imageAlt });
      expect([...row!.title]).toHaveLength([...oracle.title].length);
      if (oracle.imageAlt) expect([...row!.imageAlt!]).toHaveLength([...oracle.imageAlt].length);
    }

    async function expectAdmittedEdit(id: number, fields: Fields) {
      const oracle = oracleAdmits(fields);
      const res = await post(kitEditAction(id), fields);
      expect(res.status, "oracle-admitted input must be admitted through the Kit path").toBe(303);
      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row).toMatchObject({ title: oracle.title, imageAlt: oracle.imageAlt });
      expect([...row!.title]).toHaveLength([...oracle.title].length);
      if (oracle.imageAlt) expect([...row!.imageAlt!]).toHaveLength([...oracle.imageAlt].length);
    }

    describe("Kit new path", () => {
      for (const { label, fields, refusedKey } of refusingFixtures) {
        it(`refuses ${label} with the oracle 422 and persists nothing`, async () => {
          await expectRefused(KIT_NEW_ACTION, fields, refusedKey);
          expect(await allRows()).toHaveLength(0);
        });
      }

      it("refuses headline and image description overlong together, naming both fields", async () => {
        const fields = {
          title: ascii(256),
          image_url: IMAGE_URL,
          image_alt: ascii(256),
          position: "0",
        };
        const oracle = oracleErrors(fields);
        expect(Object.keys(oracle).sort()).toEqual(["image_alt", "title"]);
        const res = await post(KIT_NEW_ACTION, fields);
        expect(res.status).toBe(422);
        const html = await res.text();
        expect(html).toContain(oracle.title!);
        expect(html).toContain(oracle.image_alt!);
        expect(await allRows()).toHaveLength(0);
      });

      for (const { label, fields } of admittingFixtures) {
        it(`admits ${label} and stores it verbatim`, async () => {
          await expectAdmittedNew(fields);
        });
      }
    });

    describe("Kit edit path", () => {
      for (const { label, fields, refusedKey } of refusingFixtures) {
        it(`refuses ${label} with the oracle 422 and leaves the row untouched`, async () => {
          const seeded = await seedRow();
          await expectRefused(kitEditAction(seeded.id), fields, refusedKey);
          const [row] = await db
            .select()
            .from(featuredContents)
            .where(eq(featuredContents.id, seeded.id));
          expect(row).toMatchObject({ title: "Original slot", imageAlt: "Original description" });
          expect(await allRows()).toHaveLength(1);
        });
      }

      it("refuses headline and image description overlong together, naming both fields", async () => {
        const seeded = await seedRow();
        const fields = {
          title: ascii(256),
          image_url: IMAGE_URL,
          image_alt: ascii(256),
          position: "0",
        };
        const oracle = oracleErrors(fields);
        expect(Object.keys(oracle).sort()).toEqual(["image_alt", "title"]);
        const res = await post(kitEditAction(seeded.id), fields);
        expect(res.status).toBe(422);
        const html = await res.text();
        expect(html).toContain(oracle.title!);
        expect(html).toContain(oracle.image_alt!);
        const [row] = await db
          .select()
          .from(featuredContents)
          .where(eq(featuredContents.id, seeded.id));
        expect(row).toMatchObject({ title: "Original slot", imageAlt: "Original description" });
      });

      for (const { label, fields } of admittingFixtures) {
        it(`admits ${label} and stores it verbatim`, async () => {
          const seeded = await seedRow();
          await expectAdmittedEdit(seeded.id, fields);
        });
      }
    });
  },
);
