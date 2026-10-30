// Test Author owned. The missing behavior is an actual linked error summary,
// not a new validator, mutation endpoint, or a different error envelope.
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  createEvent,
  createFeatured,
  featuredSaveBaseline,
  getEvent,
  getFeatured,
  updateEvent,
  updateFeatured,
} from "../src/admin/store";
import type { Db } from "../src/db/index";
import { createMemorySessionStore } from "../src/sessions";
import { sameOrigin } from "../src/same-origin";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import {
  compileKitForms,
  eventRow,
  eventValues,
  featuredRow,
  featuredValues,
  formFixtures,
  globalError,
  key,
  summaryFragment,
  type FormFixture,
} from "./helpers/admin-validation-correction";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  getEvent: vi.fn(),
  getFeatured: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  createFeatured: vi.fn(),
  updateFeatured: vi.fn(),
}));

let compiler: Awaited<ReturnType<typeof compileKitForms>>;
let rejected: FormFixture[];
let clean: FormFixture[];
beforeAll(async () => {
  compiler = await compileKitForms();
  rejected = await formFixtures(compiler, true);
  clean = await formFixtures(compiler, false);
});
afterAll(() => compiler?.dispose());

const names = [
  "Hono event new",
  "Kit event new",
  "Hono featured new",
  "Hono event edit",
  "Kit event edit",
  "Hono featured edit",
];
function fixture(name: string) {
  return rejected.find((f) => f.name === name)!;
}

// A generic/empty/hidden summary cannot pass. Links must identify the existing
// control, not an inline error paragraph or an invented control for global errors.
describe("validation correction render contract", () => {
  for (const name of names) {
    it(`${name}: summarizes each real field error with one stable control link`, () => {
      const { html, errors, targets } = fixture(name);
      const summary = summaryFragment(html);
      expect(summary, "a real error summary is present").not.toBe("");
      expect(summary).not.toMatch(/\shidden(?:\s|=|>)/);
      expect(summary).not.toContain('aria-hidden="true"');
      for (const [field, id] of Object.entries(targets)) {
        const link = new RegExp(`<a\\b[^>]*href="#${id}"[^>]*>([\\s\\S]*?)<\\/a>`).exec(summary);
        expect(link?.[1], `${field} links to its existing control`).toBeDefined();
        expect(link![1]).toContain(errors[field]);
        expect((summary.match(new RegExp(`href="#${id}"`, "g")) ?? []).length).toBe(1);
        expect(html).toContain(`id="${id}"`);
      }
    });
    it(`${name}: unknown/global errors stay escaped and do not invent a target`, () => {
      const summary = summaryFragment(fixture(name).html);
      expect(summary).toContain("Cannot save &lt;img");
      expect(summary).toContain("&amp; retry.");
      expect(summary).not.toContain("<img src=x");
      expect(summary).not.toContain(globalError);
      expect(summary).not.toMatch(/href="#(?:f-)?global"/);
      for (const link of summary.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g))
        expect(link[1]).not.toContain("Cannot save");
    });
    it(`${name}: keeps native POST, draft protection, submitted values and inline associations`, () => {
      const f = fixture(name);
      expect(f.html).toContain(`action="${f.action}"`);
      expect(f.html).toMatch(
        /<form\b[^>]*method="post"[^>]*data-event-editor=""[^>]*data-event-draft=""/,
      );
      expect(f.html).toContain("Draft &lt;");
      expect(f.html).toContain(
        f.kind === "event" ? "second line &lt;literal" : "featured &lt;copy",
      );
      for (const id of Object.values(f.targets)) {
        const tag = [
          ...f.html.matchAll(/<(?:input|select|textarea)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g),
        ]
          .map((match) => match[0])
          .find((value) => value.includes(`id="${id}"`));
        expect(tag).toContain('aria-invalid="true"');
        expect(tag).toMatch(new RegExp(`aria-describedby="[^"]*${id}-error`));
        expect(f.html).toContain(`id="${id}-error"`);
      }
    });
  }
  for (const name of [...names, "Kit featured new", "Kit featured edit"]) {
    it(`${name}: an error-free form has no summary or rejected-draft marker`, () => {
      const f = clean.find((value) => value.name === name)!;
      expect(summaryFragment(f.html)).toBe("");
      expect(f.html).not.toContain("data-event-draft");
      expect(f.html).not.toContain('aria-invalid="true"');
      expect(f.html).toContain(`action="${f.action}"`);
    });
  }
});

// Dispatch uses the real moderator guard, same-origin gate, body cap, parsers,
// route catch/classification and renderer. Only persistence is doubled. Invalid
// submissions must never query/write a real database or call a successful save.
const dbTouched = vi.fn(() => {
  throw new Error("acceptance fixture must not query SQL");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;
async function mounted(actor: typeof MEMBER | null = MODERATOR) {
  const sessions = createMemorySessionStore();
  const cookie = actor ? await cookieFor(sessions, actor) : "";
  const app = new Hono()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: sessions, db }));
  return { app, cookie, bindings: { ...env, ADMIN_DB: db } };
}
function request(cookie: string, values: Record<string, string>, origin = env.APP_URL) {
  return {
    method: "POST",
    headers: {
      cookie,
      origin,
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values).toString(),
  };
}
function noWrites() {
  for (const save of [createEvent, updateEvent, createFeatured, updateFeatured, dbTouched])
    expect(save).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(eventRow);
  vi.mocked(getFeatured).mockResolvedValue({
    ...featuredRow,
    startsAtText: null,
    endsAtText: null,
  });
});

const posts = [
  {
    name: "event create DST-gap/capacity/recurrence",
    path: "/admin/events",
    values: eventValues,
    links: ["f-starts-at", "f-capacity", "f-recurrence-count"],
    fields: ["starts_at", "capacity", "recurrence_count"],
  },
  {
    name: "event edit DST-gap/capacity",
    path: `/admin/events/${key}`,
    values: eventValues,
    links: ["f-starts-at", "f-capacity"],
    fields: ["starts_at", "capacity"],
  },
  {
    name: "featured create image/alt/window/position",
    path: "/admin/featured",
    values: featuredValues,
    links: ["f-image-url", "f-image-alt", "f-ends-at", "f-position"],
    fields: ["image_url", "image_alt", "ends_at", "position"],
  },
  {
    name: "featured edit image/alt/window/position",
    path: "/admin/featured/7",
    // The edit dispatch submits the mocked row's real saved-content baseline,
    // the way a rendered edit form carries it; only persistence is doubled.
    values: {
      ...featuredValues,
      saved_baseline: await featuredSaveBaseline({
        ...featuredRow,
        startsAtText: null,
        endsAtText: null,
      }),
    },
    links: ["f-image-url", "f-image-alt", "f-ends-at", "f-position"],
    fields: ["image_url", "image_alt", "ends_at", "position"],
  },
];
describe("real native rejected document dispatch", () => {
  for (const row of posts) {
    it(`${row.name}: 422 summary links actual validator errors`, async () => {
      const { app, cookie, bindings } = await mounted();
      const response = await app.request(row.path, request(cookie, row.values), bindings);
      expect(response.status).toBe(422);
      const html = await response.text();
      const summary = summaryFragment(html);
      expect(summary).not.toBe("");
      for (const id of row.links) expect(summary).toContain(`href="#${id}"`);
      noWrites();
    });
    it(`${row.name}: positive control preserves rejected input, associations and no-save classification`, async () => {
      const { app, cookie, bindings } = await mounted();
      const response = await app.request(row.path, request(cookie, row.values), bindings);
      expect(response.status).toBe(422);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.has("location")).toBe(false);
      const html = await response.text();
      expect(html).toContain("Draft &lt;");
      expect(html).toContain('data-event-draft=""');
      for (const field of row.fields) expect(html).toContain(`data-testid="error-${field}"`);
      noWrites();
    });
  }
  it("a forged immutable event key remains a visible untargeted validation error", async () => {
    const { app, cookie, bindings } = await mounted();
    const values = { ...eventValues, event_key: "forged-key" };
    const response = await app.request("/admin/events", request(cookie, values), bindings);
    expect(response.status).toBe(422);
    const summary = summaryFragment(await response.text());
    expect(summary).toContain(
      "The event key is assigned when the event is created and cannot be changed.",
    );
    expect(summary).not.toContain('href="#f-event-key"');
    noWrites();
  });
  it("guests and non-moderators never get a validation page", async () => {
    for (const actor of [null, MEMBER]) {
      const { app, cookie, bindings } = await mounted(actor);
      const response = await app.request("/admin/events", request(cookie, eventValues), bindings);
      expect(response.status).toBe(actor ? 403 : 303);
      expect(await response.text()).not.toContain('data-testid="form-errors"');
    }
    noWrites();
  });
  it("cross-origin and oversized bodies retain admission failures rather than a correction summary", async () => {
    const { app, cookie, bindings } = await mounted();
    const cross = await app.request(
      "/admin/featured",
      request(cookie, featuredValues, "https://other.example.test"),
      bindings,
    );
    expect(cross.status).toBe(403);
    const over = await app.request(
      "/admin/featured",
      { ...request(cookie, featuredValues), body: "x".repeat(BODY_LIMIT_BYTES.featured + 1) },
      bindings,
    );
    expect(over.status).toBe(413);
    expect(await cross.text()).not.toContain('data-testid="form-errors"');
    expect(await over.text()).not.toContain('data-testid="form-errors"');
    noWrites();
  });
});
