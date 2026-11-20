import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildEventCreateView } from "../src/admin/kit-event-create";
import { parseRecurrenceForm } from "../src/admin/recurrence";
import { adminApp } from "../src/admin/routes";
import { parseEventForm } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { decideOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import { control, fields, nativeForm, values } from "./helpers/admin-create-content-form";
import { eventEditorBrowser } from "./helpers/admin-event-editor";
import { compileKitForms, summaryFragment } from "./helpers/admin-validation-correction";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

let kit: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  kit = await compileKitForms();
});
afterAll(() => kit?.dispose());
const render = (v: Record<string, string> = {}, e: Record<string, string> = {}) =>
  kit.renderForm(0, buildEventCreateView(v, e));

it.each(fields)("renders optional $name with its label and public-safe help", (field) => {
  const html = render();
  const entry = control(html, field.name);
  expect(entry.tag).toBe(field.tag);
  expect(entry.attrs.id).toBe(field.id);
  expect(entry.attrs).not.toHaveProperty("required");
  expect(entry.attrs["aria-invalid"]).toBeUndefined();
  expect(html).toContain(`<label for="${field.id}">${field.label}</label>`);
  expect(entry.attrs["aria-describedby"]?.split(/\s+/)).toContain(`${field.id}-hint`);
  expect(html).toContain(`id="${field.id}-hint"`);
  expect(html).toContain(field.hint);
  if (field.name === "join_url") expect(entry.attrs.type).toBe("url");
  else expect(entry.attrs["data-event-text-limit"]).toBe(String(field.limit));
  expect(entry.attrs).not.toHaveProperty("maxlength");
  expect(nativeForm(html).body.get(field.name)).toBe("");
});

it.each(fields)("escapes retained $name and links the correction target", (field) => {
  const hostile = '</textarea><img data-content-injected="yes" src=x> & "public"';
  const error = `${field.message} <img data-error-injected="yes" src=x>`;
  const html = render({ ...values, [field.name]: hostile }, { [field.name]: error });
  const entry = control(html, field.name);
  expect(nativeForm(html).body.get(field.name)).toBe(hostile);
  expect(html).not.toContain('<img data-content-injected="yes"');
  expect(html).not.toContain('<img data-error-injected="yes"');
  expect(entry.attrs["aria-invalid"]).toBe("true");
  expect(entry.attrs["aria-describedby"]?.split(/\s+/)).toEqual(
    expect.arrayContaining([`${field.id}-hint`, `${field.id}-error`]),
  );
  expect(html).toContain(`id="${field.id}-error"`);
  expect(html).toContain(`data-testid="error-${field.name}"`);
  expect(summaryFragment(html)).toContain(`href="#${field.id}"`);
  expect(summaryFragment(html)).toContain(field.message);
  expect(nativeForm(html).attrs).toHaveProperty("data-event-draft", "");
});

it.each(fields)("serializes $name at the boundary and tracks unsaved changes", (field) => {
  const isUrl = field.name === "join_url";
  const prefix = "https://example.test/";
  const value = isUrl ? prefix.padEnd(field.limit, "x") : "😀".repeat(field.limit);
  const key = field.name === "accessibility_notes" ? "accessibilityNotes" : field.name;
  const boundary = nativeForm(render({ ...values, [field.name]: value })).body;
  expect(boundary.get(field.name)).toBe(value);
  expect(parseEventForm(Object.fromEntries(boundary))[key]).toBe(value);
  const overflow = nativeForm(
    render({ ...values, [field.name]: value + (isUrl ? "x" : "😀") }),
  ).body;
  expect(() => parseEventForm(Object.fromEntries(overflow))).toThrow(field.name);
  const form = nativeForm(render(values));
  expect(form.body.has(field.name)).toBe(true);
  expect(form.attrs).toHaveProperty("data-event-editor", "");
  const browser = eventEditorBrowser({ initial: Object.fromEntries(form.body) });
  expect(browser.navigate("unrelated").preventDefault).not.toHaveBeenCalled();
  browser.values.set(field.name, "Changed public detail");
  browser.input();
  expect(browser.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
  expect(
    parseEventForm(Object.fromEntries(nativeForm(render({ ...values, [field.name]: "" })).body))[
      key
    ],
  ).toBeNull();
});

it("retains all four serialized details through the real Hono validation response", async () => {
  const touched = vi.fn(() => {
    throw new Error("Unexpected SQL");
  });
  const db = Object.fromEntries(
    ["select", "insert", "update", "delete", "transaction", "execute"].map((key) => [key, touched]),
  ) as unknown as Db;
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MODERATOR);
  const app = new Hono()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: sessions, db }));
  const form = nativeForm(render({ ...values, title: "" }));
  expect(form.attrs.method).toBe("post");
  expect(form.attrs.action).toBe("/admin/events");
  const response = await app.request(
    "/admin/events",
    {
      method: "POST",
      headers: {
        cookie,
        origin: env.APP_URL,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.body,
    },
    { ...env, ADMIN_DB: db },
  );
  expect(response.status).toBe(422);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.has("location")).toBe(false);
  expect(touched).not.toHaveBeenCalled();
  const html = await response.text();
  expect(summaryFragment(html)).toContain('href="#f-title"');
  const echoed = nativeForm(html).body;
  for (const field of fields) {
    const want = field.value.replace(/\n/g, "\r\n");
    expect(form.body.get(field.name), `Kit serializes ${field.name}`).toBe(want);
    expect(echoed.get(field.name), `Hono retains ${field.name}`).toBe(want);
  }

  const field = fields[0];
  for (const [value, message] of [
    ["😀".repeat(field.limit + 1), field.message],
    ["Public​detail", "Remove control or invisible characters."],
  ] as const) {
    const invalid = nativeForm(render({ ...values, [field.name]: value }));
    const rejected = await app.request(
      "/admin/events",
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: invalid.body,
      },
      { ...env, ADMIN_DB: db },
    );
    expect(rejected.status).toBe(422);
    const rejectedHtml = await rejected.text();
    expect(summaryFragment(rejectedHtml)).toContain(message);
    expect(nativeForm(rejectedHtml).body.get(field.name)).toBe(value);
    expect(touched).not.toHaveBeenCalled();
  }
});

it("preserves the native draft action, recurrence, timezone and disabled Kit ownership", () => {
  const html = render(values);
  const form = nativeForm(html);
  expect(form.attrs.method).toBe("post");
  expect(form.attrs.action).toBe("/admin/events");
  expect(html).toContain("Create draft");
  for (const name of ["status", "is_published", "starts_at_utc"]) {
    expect(form.body.has(name)).toBe(false);
  }
  expect(parseEventForm(Object.fromEntries(form.body))).toMatchObject({
    startsAtUtc: new Date("2030-06-05T19:00:00Z"),
    endsAtUtc: new Date("2030-06-05T21:00:00Z"),
    timezone: "Europe/London",
  });
  expect(parseRecurrenceForm(Object.fromEntries(form.body))).toMatchObject({
    frequency: "weekly",
    count: 3,
  });
  expect(html).toContain("/islands/admin-event-text-limits.js");
  expect(html).toContain("/islands/admin-event-editor.js");
  expect(form.attrs).not.toHaveProperty("data-event-draft");
  for (const method of ["GET", "HEAD", "POST"]) {
    const path = method === "POST" ? "/admin/events" : "/admin/events/new";
    expect(decideOwner(new Request(`${env.APP_URL}${path}`, { method }))).toBe("hono");
  }
  expect(ROUTE_MANIFEST.find((entry) => entry.path === "/admin/events/new")?.reads).toEqual({
    resource: "events",
    action: "view",
    route: "admin.events.create",
  });
});

it("allows all four controls to be blank together", () => {
  const blank = Object.fromEntries(fields.map(({ name }) => [name, ""]));
  const form = nativeForm(render({ ...values, ...blank }));
  expect(parseEventForm(Object.fromEntries(form.body))).toMatchObject({
    accessibilityNotes: null,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
  });
});

const island = readFileSync(
  new URL("../public/islands/admin-event-text-limits.js", import.meta.url).pathname,
  "utf8",
);
const { eventTextLimitError } = runInNewContext(
  island.replace(/(^|;)export (?=function |const |let |var |class )/gm, "$1") +
    "\n({ eventTextLimitError });",
) as { eventTextLimitError: (value: string, field: string, limit: number) => string };
it.each(fields.filter(({ name }) => name !== "join_url"))(
  "uses the shared Unicode-safe progressive limit for $name",
  (field) => {
    const entry = control(render(values), field.name);
    const limit = Number(entry.attrs["data-event-text-limit"]);
    expect(limit).toBe(field.limit);
    expect(eventTextLimitError("😀".repeat(field.limit), field.name, limit)).toBe("");
    expect(eventTextLimitError("😀".repeat(field.limit + 1), field.name, limit)).not.toBe("");
  },
);
