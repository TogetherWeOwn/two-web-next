// route-inventory: POST /admin/featured/:id
// Native Kit forms deliberately submit to the real Hono write authority.
// Companion acceptance history: this round trip requires the separately
// owned stale-save refusal contract. It is deliberately RED until that
// contract lands; do not merge this file ahead of it.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  editorForm,
  attr,
  entry,
  honoSession,
  links,
  origin,
  query,
  renderEditor,
  slot,
  type Renderer,
} from "./helpers/featured-inventory-return";

let fixture: MemberDataFixture;
let db: Db;
let request: Awaited<ReturnType<typeof honoSession>>;
const sql: string[] = [];
beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Featured return write acceptance requires the approved disposable DATABASE_URL; no skipped proof",
    );
  fixture = await createMemberDataFixture(process.env.DATABASE_URL);
  db = drizzle(fixture.client, {
    schema: { ...schema, ...adminSchema },
    logger: {
      logQuery: (query) => {
        sql.push(query);
      },
    },
  });
});
afterAll(() => fixture?.dispose());
beforeEach(async () => {
  await fixture.reset();
  await db.delete(featuredContents);
  await db.insert(featuredContents).values({
    id: 7,
    title: slot.title,
    body: "Saved body",
    isPublished: false,
    position: 7,
    startsAt: null,
    endsAt: null,
    createdAt: new Date("2099-11-01T18:00:00Z"),
    updatedAt: new Date("2099-11-01T18:00:00Z"),
  });
  request = await honoSession(db);
  sql.length = 0;
});
const post = (action: string, fields: URLSearchParams) =>
  request(action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: fields,
  });
function privateResponse(response: Response) {
  const directives = response.headers.get("cache-control")?.split(/,\s*/);
  expect(directives).toContain("private");
  expect(directives).toContain("no-store");
}
function sameResults(html: string) {
  for (const label of ["Back to these featured results", "Cancel"]) {
    const a = links(html).find((a) => a.label === label);
    expect(a, `native ${label} must retain the originating inventory after the POST`).toBeDefined();
    expect(a!.url.origin).toBe(origin);
    expect(a!.url.pathname).toBe("/admin/featured");
    expect(Object.fromEntries(a!.url.searchParams)).toEqual({
      q: query,
      published: "0",
      sort: "updated_at",
      order: "desc",
      page: "2",
    });
  }
}
async function formFrom(renderer: Renderer, deletion = false) {
  const { url } = await entry(renderer);
  const rendered = await renderEditor(renderer, url, { db });
  expect(rendered.status).toBe(200);
  const form = editorForm(rendered.html, deletion);
  expect(form.method).toBe("post");
  return { ...form, url };
}

for (const renderer of ["Hono", "Kit"] as Renderer[])
  describe(`${renderer} native featured return stale save`, () => {
    it("a stale save is refused with the editable draft and original inventory, never an overwrite", async () => {
      const form = await formFrom(renderer);
      await db
        .update(featuredContents)
        .set({
          title: "Other moderator saved this",
          body: "Newer saved body",
          updatedAt: new Date("2099-11-01T18:01:00Z"),
        })
        .where(eq(featuredContents.id, 7));
      form.fields.set("title", "My stale draft");
      form.fields.set("body", "Do not discard my edits");
      sql.length = 0;
      const response = await post(form.action, form.fields);
      expect(
        response.status,
        "stale refusal belongs to the existing featured stale-write contract",
      ).toBe(409);
      privateResponse(response);
      const html = await response.text();
      const refused = editorForm(html);
      expect(refused.fields.get("title")).toBe("My stale draft");
      expect(refused.fields.get("body")).toBe("Do not discard my edits");
      expect(attr(refused.node, "data-event-draft")).toBeDefined();
      sameResults(html);
      expect((await db.select().from(featuredContents))[0]!).toMatchObject({
        title: "Other moderator saved this",
        body: "Newer saved body",
      });
      expect(await db.select().from(activityLog)).toHaveLength(0);
    });
  });
