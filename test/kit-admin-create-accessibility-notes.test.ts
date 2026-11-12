import { Hono } from "hono";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildEventCreateView } from "../src/admin/kit-event-create";
import { adminApp } from "../src/admin/routes";
import { parseEventForm } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import { control, fields, nativeForm, values } from "./helpers/admin-create-content-form";
import { eventEditorBrowser } from "./helpers/admin-event-editor";
import { compileKitForms, summaryFragment } from "./helpers/admin-validation-correction";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

const field = fields[0];
let kit: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  kit = await compileKitForms();
});
afterAll(() => kit?.dispose());
const render = (v: Record<string, string> = {}, e: Record<string, string> = {}) =>
  kit.renderForm(0, buildEventCreateView(v, e));

it("renders an optional accessibility control with its label and public-safe help", () => {
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
  expect(entry.attrs["data-event-text-limit"]).toBe(String(field.limit));
  expect(entry.attrs).not.toHaveProperty("maxlength");
  expect(nativeForm(html).body.get(field.name)).toBe("");
});

it("escapes retained text and errors and links the correction target", () => {
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

it("serializes the full Unicode boundary and participates in dirty-form protection", () => {
  const value = "😀".repeat(field.limit);
  const boundary = nativeForm(render({ ...values, [field.name]: value })).body;
  expect(boundary.get(field.name)).toBe(value);
  expect(parseEventForm(Object.fromEntries(boundary)).accessibilityNotes).toBe(value);
  const overflow = nativeForm(render({ ...values, [field.name]: `${value}😀` })).body;
  expect(() => parseEventForm(Object.fromEntries(overflow))).toThrow("accessibility_notes");
  const form = nativeForm(render(values));
  expect(form.body.has(field.name)).toBe(true);
  expect(form.attrs).toHaveProperty("data-event-editor", "");
  const browser = eventEditorBrowser({ initial: Object.fromEntries(form.body) });
  expect(browser.navigate("unrelated").preventDefault).not.toHaveBeenCalled();
  browser.values.set(field.name, "Changed public detail");
  browser.input();
  expect(browser.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
  expect(
    parseEventForm(Object.fromEntries(nativeForm(render({ ...values, [field.name]: "" })).body))
      .accessibilityNotes,
  ).toBeNull();
});

it("retains the serialized notes through the real Hono validation response", async () => {
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
  expect(form.body.get(field.name)).toBe(field.value);
  expect(nativeForm(html).body.get(field.name)).toBe(field.value);

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
