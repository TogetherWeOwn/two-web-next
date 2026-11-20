// Baseline controls extracted from the create-form acceptance tests.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventFormPage } from "../src/admin/pages";
import { adminApp } from "../src/admin/routes";
import { parseEventForm } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import { control, fields, nativeForm, values } from "./helpers/admin-create-content-form";
import { eventEditorBrowser } from "./helpers/admin-event-editor";
import { summaryFragment } from "./helpers/admin-validation-correction";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

function boundary(name: string, limit: number): string {
  if (name !== "join_url") return "😀".repeat(limit);
  const prefix = "https://example.test/";
  return prefix + "x".repeat(limit - prefix.length);
}

async function renderHono(v: Record<string, string>, errors: Record<string, string> = {}) {
  return (await EventFormPage({ mode: "new", values: v, errors }))!.toString();
}

const dbTouched = vi.fn(() => {
  throw new Error("No SQL is permitted in this local validation fixture");
});
const db = Object.fromEntries(
  ["select", "insert", "update", "delete", "transaction", "execute"].map((method) => [
    method,
    dbTouched,
  ]),
) as unknown as Db;
beforeEach(() => vi.clearAllMocks());
async function mounted(actor: typeof MEMBER | null = MODERATOR) {
  const sessions = createMemorySessionStore();
  const cookie = actor ? await cookieFor(sessions, actor) : "";
  const app = new Hono()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: sessions, db }));
  return { app, cookie, bindings: { ...env, ADMIN_DB: db } };
}
async function post(
  body: URLSearchParams,
  actor: typeof MEMBER | null = MODERATOR,
  origin = env.APP_URL,
) {
  const { app, cookie, bindings } = await mounted(actor);
  return app.request(
    "/admin/events",
    {
      method: "POST",
      headers: {
        cookie,
        origin,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
    bindings,
  );
}
function refusedWithoutEffects(response: Response) {
  expect(response.status).toBe(422);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.has("location")).toBe(false);
  expect(dbTouched).not.toHaveBeenCalled();
}

describe("bounded native form serializer controls", () => {
  const hostile = '</textarea><img data-content-injected="yes" src=x> & "public"';
  for (const fixture of [
    {
      quote: "double",
      name: "organizer_name",
      input:
        '<input name="organizer_name" value="&lt;/textarea>&lt;img data-content-injected=&quot;yes&quot; src=x> &amp; &quot;public&quot;" id="quoted-input">',
    },
    {
      quote: "single",
      name: "join_url",
      input:
        "<input value='&lt;/textarea>&lt;img data-content-injected=&quot;yes&quot; src=x> &amp; &quot;public&quot;' name='join_url' id='quoted-input'>",
    },
  ]) {
    it(`${fixture.quote}-quoted > survives serialization with attributes and controls after it`, () => {
      const html = `<form method="post">${fixture.input}<input name="after" value="still here"></form>`;
      expect([...nativeForm(html).body]).toEqual([
        [fixture.name, hostile],
        ["after", "still here"],
      ]);
      expect(control(html, fixture.name).attrs.id).toBe("quoted-input");
    });

    it(`${fixture.quote}-quoted input cannot be synthesized when absent, disabled or truncated`, () => {
      expect(nativeForm('<form method="post"></form>').body.has(fixture.name)).toBe(false);
      const disabled = fixture.input.replace("<input ", "<input disabled ");
      expect(nativeForm(`<form method="post">${disabled}</form>`).body.has(fixture.name)).toBe(
        false,
      );
      const truncated = `<form method="post"><input name="${fixture.name}" value="&lt;/textarea"></form>`;
      expect(nativeForm(truncated).body.get(fixture.name)).toBe("</textarea");
      expect(nativeForm(truncated).body.get(fixture.name)).not.toBe(hostile);
    });
  }
});

describe("existing Hono authority preservation controls", () => {
  it.each(fields)(
    "Hono reference $name: retained text, correction associations and shared draft protection work",
    async (field) => {
      const hostile = '</textarea><img data-content-injected="yes" src=x> & "public"';
      const html = await renderHono(
        { ...values, [field.name]: hostile },
        { [field.name]: field.message },
      );
      const entry = control(html, field.name);
      expect(entry.attrs.id).toBe(field.id);
      expect(entry.attrs).not.toHaveProperty("required");
      expect(nativeForm(html).body.get(field.name)).toBe(hostile);
      expect(html).not.toContain('<img data-content-injected="yes"');
      expect(entry.attrs["aria-invalid"]).toBe("true");
      expect(entry.attrs["aria-describedby"]?.split(/\s+/)).toEqual(
        expect.arrayContaining([`${field.id}-hint`, `${field.id}-error`]),
      );
      expect(summaryFragment(html)).toContain(`href="#${field.id}"`);
      expect(html).toContain(field.hint);
      const browser = eventEditorBrowser({ initial: Object.fromEntries(nativeForm(html).body) });
      expect(browser.navigate("unrelated").preventDefault).not.toHaveBeenCalled();
      browser.values.set(field.name, "Changed public detail");
      browser.input();
      expect(browser.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
    },
  );
  it("positive control: the Hono form already carries all four values through the real 422 path", async () => {
    const form = nativeForm(await renderHono({ ...values, title: "" }));
    const response = await post(form.body);
    refusedWithoutEffects(response);
    const echoed = nativeForm(await response.text()).body;
    for (const field of fields)
      expect(echoed.get(field.name)).toBe(field.value.replace(/\n/g, "\r\n"));
  });

  for (const field of fields) {
    it(`${field.name}: server rejects over-limit text without a persistence or read-audit effect`, async () => {
      const response = await post(
        new URLSearchParams({ ...values, [field.name]: boundary(field.name, field.limit + 1) }),
      );
      refusedWithoutEffects(response);
      const html = await response.text();
      expect(summaryFragment(html)).toContain(`href="#${field.id}"`);
      expect(html).toContain(field.message);
    });
    it(`${field.name}: server rejects invisible controls without a persistence or read-audit effect`, async () => {
      const response = await post(
        new URLSearchParams({ ...values, [field.name]: `${field.value}​` }),
      );
      refusedWithoutEffects(response);
      expect(await response.text()).toContain("Remove control or invisible characters.");
    });
    it(`${field.name}: existing validator accepts the exact code-point boundary`, () => {
      const parsed = parseEventForm({ ...values, [field.name]: boundary(field.name, field.limit) });
      const key = field.name === "accessibility_notes" ? "accessibilityNotes" : field.name;
      expect(parsed[key]).toBe(boundary(field.name, field.limit));
    });
  }
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "ftp://example.test/lobby",
    "https://person:pass@example.test/lobby",
  ])("server refuses non-public joining link %s without effects", async (join_url) => {
    const response = await post(new URLSearchParams({ ...values, join_url }));
    refusedWithoutEffects(response);
    expect(await response.text()).toContain(
      "Enter a valid public HTTP or HTTPS link without sign-in credentials.",
    );
  });
  it.each(["http://example.test/lobby", "https://example.test/lobby"])(
    "accepts public joining scheme %s",
    (join_url) => {
      expect(parseEventForm({ ...values, join_url }).join_url).toBe(join_url);
    },
  );
  it.each([null, MEMBER])(
    "refuses a non-moderator native submission before SQL (%j)",
    async (actor) => {
      const response = await post(new URLSearchParams(values), actor);
      expect(response.status).toBe(actor ? 403 : 303);
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );
  it("refuses cross-origin native writes before SQL", async () => {
    const response = await post(
      new URLSearchParams(values),
      MODERATOR,
      "https://other.example.test",
    );
    expect(response.status).toBe(403);
    expect(dbTouched).not.toHaveBeenCalled();
  });
});
