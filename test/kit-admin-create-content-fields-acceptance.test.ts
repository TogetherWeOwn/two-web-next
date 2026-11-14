// Test Author owned: pre-enable create-form parity, not edit or route enablement.
// Compile the real Svelte component; only SQL is replaced with a fail-closed
// effect counter. Native submissions exercise the real Hono guard and validators.
// Real-store success proofs register in admin.test.ts via the persistence helper.
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventCreateView } from "../src/admin/kit-event-create";
import { EventFormPage } from "../src/admin/pages";
import { parseRecurrenceForm } from "../src/admin/recurrence";
import { adminApp } from "../src/admin/routes";
import { parseEventForm } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { decideOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import {
  content,
  control,
  decode,
  fields,
  nativeForm,
  values,
} from "./helpers/admin-create-content-form";
import { eventEditorBrowser } from "./helpers/admin-event-editor";
import { compileKitForms, summaryFragment } from "./helpers/admin-validation-correction";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

function boundary(name: string, limit: number): string {
  if (name !== "join_url") return "😀".repeat(limit);
  const prefix = "https://example.test/";
  return prefix + "x".repeat(limit - prefix.length);
}

let kit: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  kit = await compileKitForms();
});
afterAll(() => kit?.dispose());
const renderKit = (v: Record<string, string> = {}, e: Record<string, string> = {}) =>
  kit.renderForm(0, buildEventCreateView(v, e));
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

for (const field of fields) {
  describe(`Kit create ${field.name}`, () => {
    it("renders the existing optional Hono control, label and associated public-safe help", () => {
      const html = renderKit();
      const entry = control(html, field.name);
      expect(entry.tag).toBe(field.tag);
      expect(entry.attrs.id).toBe(field.id);
      expect(entry.attrs).not.toHaveProperty("required");
      expect(entry.attrs["aria-invalid"]).toBeUndefined();
      expect(html).toContain(`<label for="${field.id}">${field.label}</label>`);
      const descriptions = entry.attrs["aria-describedby"]?.split(/\s+/) ?? [];
      expect(descriptions).toContain(`${field.id}-hint`);
      expect(html).toContain(`id="${field.id}-hint"`);
      expect(html).toContain(field.hint);
      if (field.name === "join_url") expect(entry.attrs.type).toBe("url");
      else {
        expect(entry.attrs["data-event-text-limit"]).toBe(String(field.limit));
        expect(entry.attrs).not.toHaveProperty("maxlength");
      }
      expect(nativeForm(html).body.get(field.name)).toBe("");
    });

    it("echoes hostile input as text and associates field errors with a real correction target", () => {
      const hostile = '</textarea><img data-content-injected="yes" src=x> & "public"';
      const error = `${field.message} <img data-error-injected="yes" src=x>`;
      const html = renderKit({ ...values, [field.name]: hostile }, { [field.name]: error });
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

    it("carries the full code-point boundary through the real form without native truncation", () => {
      const value = boundary(field.name, field.limit);
      expect(nativeForm(renderKit({ ...values, [field.name]: value })).body.get(field.name)).toBe(
        value,
      );
    });

    it("includes the field in the shared dirty-form departure protection", () => {
      const form = nativeForm(renderKit(values));
      expect(form.body.has(field.name)).toBe(true);
      expect(form.attrs).toHaveProperty("data-event-editor", "");
      const browser = eventEditorBrowser({ initial: Object.fromEntries(form.body) });
      expect(browser.navigate("unrelated").preventDefault).not.toHaveBeenCalled();
      browser.values.set(field.name, "Changed public detail");
      browser.input();
      expect(browser.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
    });
  });
}

describe("real Kit form to Hono native POST", () => {
  it("retains all four serialized values on the current 422 page without JavaScript or SQL", async () => {
    const form = nativeForm(renderKit({ ...values, title: "" }));
    expect(form.attrs.method).toBe("post");
    expect(form.attrs.action).toBe("/admin/events");
    const response = await post(form.body);
    refusedWithoutEffects(response);
    const html = await response.text();
    expect(summaryFragment(html)).toContain('href="#f-title"');
    const echoed = nativeForm(html).body;
    for (const field of fields) {
      const want = field.value.replace(/\n/g, "\r\n");
      expect(form.body.get(field.name), `Kit serializes ${field.name}`).toBe(want);
      expect(echoed.get(field.name), `Hono retains ${field.name}`).toBe(want);
    }
  });

  it("preserves draft-first action, recurrence and timezone without publishing or enabling routes", () => {
    const html = renderKit(values);
    const form = nativeForm(html);
    expect(form.attrs.method).toBe("post");
    expect(form.attrs.action).toBe("/admin/events");
    expect(html).toContain("Create draft");
    expect(form.body.has("status")).toBe(false);
    expect(form.body.has("is_published")).toBe(false);
    expect(form.body.has("starts_at_utc")).toBe(false);
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
    const route = ROUTE_MANIFEST.find((entry) => entry.path === "/admin/events/new");
    expect(route?.reads).toEqual({
      resource: "events",
      action: "view",
      route: "admin.events.create",
    });
  });

  it("keeps all four empty values optional in existing validation", () => {
    const form = nativeForm(
      renderKit({ ...values, ...Object.fromEntries(fields.map((f) => [f.name, ""])) }),
    );
    expect(parseEventForm(Object.fromEntries(form.body))).toMatchObject({
      accessibilityNotes: null,
      organizer_name: null,
      join_url: null,
      join_instructions: null,
    });
  });
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

const island = readFileSync(
  new URL("../public/islands/admin-event-text-limits.js", import.meta.url).pathname,
  "utf8",
);
const { eventTextLimitError } = runInNewContext(
  island.replace(/(^|;)export (?=function |const |let |var |class )/gm, "$1") +
    "\n({ eventTextLimitError });",
) as { eventTextLimitError: (value: string, field: string, limit: number) => string };
for (const field of fields.filter((entry) => entry.name !== "join_url")) {
  it(`${field.name}: rendered progressive annotation uses the shared Unicode-safe limit`, () => {
    const entry = control(renderKit(values), field.name);
    const limit = Number(entry.attrs["data-event-text-limit"]);
    expect(limit).toBe(field.limit);
    expect(eventTextLimitError("😀".repeat(field.limit), field.name, limit)).toBe("");
    expect(eventTextLimitError("😀".repeat(field.limit + 1), field.name, limit)).not.toBe("");
  });
}
