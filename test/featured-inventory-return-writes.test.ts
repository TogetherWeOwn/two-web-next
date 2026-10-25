// route-inventory: POST /admin/featured/:id
// route-inventory: POST /admin/featured/:id/delete
// Native Kit forms deliberately submit to the real Hono write authority.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  editorForm,
  elements,
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
const featureReads = () =>
  sql.filter((q) => /^select /i.test(q) && /from "featured_contents"/.test(q));
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
  describe(`${renderer} native featured return writes`, () => {
    it("Save succeeds even when the renamed/published slot leaves its old results, and keeps context on the edit page", async () => {
      const form = await formFrom(renderer);
      form.fields.set("title", "Renamed outside the original search");
      form.fields.set("body", "Saved new body");
      form.fields.set("is_published", "on");
      sql.length = 0;
      const response = await post(form.action, form.fields);
      expect(response.status).toBe(303);
      privateResponse(response);
      expect(featureReads()).toHaveLength(2); // admission snapshot + transactional locked row, no list/count read
      const destination = new URL(response.headers.get("location")!, origin);
      expect(destination.pathname).toBe("/admin/featured/7");
      const [saved] = await db.select().from(featuredContents).where(eq(featuredContents.id, 7));
      expect(saved).toMatchObject({
        title: "Renamed outside the original search",
        body: "Saved new body",
        isPublished: true,
      });
      const logs = await db.select().from(activityLog);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ subjectType: "FeaturedContent", subjectId: "7" });
      expect(JSON.stringify(logs[0]!.properties)).toContain("Renamed outside the original search");
      const after = await renderEditor(renderer, destination, { db });
      expect(after.status).toBe(200);
      sameResults(after.html);
      expect(
        elements(after.html, "input").find((i) => attr(i, "name") === "title")?.attrs,
      ).toContainEqual({ name: "value", value: "Renamed outside the original search" });
    });

    it("422 redisplay retains the unsaved editable draft and inventory without a write or extra read", async () => {
      const form = await formFrom(renderer);
      form.fields.set("title", 'Draft <headline> & "quotes"');
      form.fields.set("body", "Unsent draft body");
      form.fields.set("position", "not-an-integer");
      sql.length = 0;
      const response = await post(form.action, form.fields);
      expect(response.status).toBe(422);
      privateResponse(response);
      expect(featureReads()).toHaveLength(1);
      const html = await response.text();
      const returned = editorForm(html);
      expect(returned.fields.get("title")).toBe('Draft <headline> & "quotes"');
      expect(returned.fields.get("body")).toBe("Unsent draft body");
      expect(returned.fields.get("position")).toBe("not-an-integer");
      expect(attr(returned.node, "data-event-draft")).toBeDefined();
      expect((await db.select().from(featuredContents))[0]!.title).toBe(slot.title);
      expect(await db.select().from(activityLog)).toHaveLength(0);
      sameResults(html);
      // Correcting and resubmitting the *returned native form* retains context too.
      returned.fields.set("position", "8");
      const corrected = await post(returned.action, returned.fields);
      expect(corrected.status).toBe(303);
      sameResults(
        (await renderEditor(renderer, new URL(corrected.headers.get("location")!, origin), { db }))
          .html,
      );
    });

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

    it("the native Delete form returns to the normalized originating page and leaves one reconstruction audit", async () => {
      const form = await formFrom(renderer, true);
      expect(new URL(form.action, origin).pathname).toBe("/admin/featured/7/delete");
      sql.length = 0;
      const response = await post(form.action, form.fields);
      expect(response.status).toBe(303);
      privateResponse(response);
      expect(featureReads()).toHaveLength(1); // locked delete snapshot only; no inventory/count query
      expect(await db.select().from(featuredContents)).toHaveLength(0);
      const audit = await db.select().from(activityLog);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.properties).toMatchObject({ title: { before: slot.title, after: null } });
      const destination = new URL(response.headers.get("location")!, origin);
      expect(destination.pathname).toBe("/admin/featured");
      expect(Object.fromEntries(destination.searchParams)).toEqual({
        q: query,
        published: "0",
        sort: "updated_at",
        order: "desc",
        page: "2",
      });
      // The originating page can now be empty; that is a successful delete, not a save failure.
      const returned = await request(destination);
      expect(returned.status).toBe(200);
      expect(await returned.text()).toContain("No results on this page.");
      const repeat = await post(form.action, form.fields);
      expect(repeat.status).toBe(404);
      expect(await db.select().from(activityLog)).toHaveLength(1);
    });

    it("CONTROL: context-free forms preserve the original Save and Delete destinations", async () => {
      const edit = await renderEditor(renderer, new URL("/admin/featured/7", origin), { db });
      const save = editorForm(edit.html);
      save.fields.set("title", "Ordinary edit");
      const saved = await post(save.action, save.fields);
      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toBe("/admin/featured/7");
      const refreshed = await renderEditor(
        renderer,
        new URL(saved.headers.get("location")!, origin),
        { db },
      );
      const deletion = editorForm(refreshed.html, true);
      const deleted = await post(deletion.action, deletion.fields);
      expect(deleted.status).toBe(303);
      expect(deleted.headers.get("location")).toBe("/admin/featured");
    });
  });

it("CONTROL: hostile contextual POSTs cannot bypass admission, origin or body limits", async () => {
  const target = new URL("/admin/featured/7?returnTo=https%3A%2F%2Fevil.example", origin);
  const member = await honoSession(db, "member");
  for (const suffix of ["", "/delete"]) {
    target.pathname = `/admin/featured/7${suffix}`;
    sql.length = 0;
    const denied = await member(target, { method: "POST", body: "title=blocked" });
    expect(denied.status).toBe(403);
    expect(featureReads()).toEqual([]);
    const crossOrigin = await request(target, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: "title=blocked",
    });
    expect(crossOrigin.status).toBe(403);
    expect(featureReads()).toEqual([]);
    const oversized = await request(target, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "x=" + "x".repeat(300_000),
    });
    expect(oversized.status).toBe(413);
    expect(featureReads()).toEqual([]);
  }
  expect((await db.select().from(featuredContents))[0]!.title).toBe(slot.title);
  expect(await db.select().from(activityLog)).toHaveLength(0);
});
