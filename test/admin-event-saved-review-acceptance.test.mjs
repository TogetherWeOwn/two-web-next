// Independent failing-first acceptance. Native browser cases live in the paired
// e2e spec; this default Vitest suite needs no Chromium and no new gate/skip.
// Breaks caught: missing/wrong saved review; false provenance/readiness; error
// drafts presented as saved; stale advice replacing locked publication checks;
// draft detail access widening. All fixtures are synthetic and schema-isolated.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIELDS,
  KEY,
  NOW,
  ORIGIN,
  UPDATED,
  savedEventFixture,
} from "./helpers/saved-event-review-fixture.mjs";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

let fixture;
const text = (html) => html.replace(/<!--[\s\S]*?-->|<[^>]+>/g, " ").replace(/\s+/g, " ");
const reviewAnchors = (html) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].filter(
    (match) => /review|preview/i.test(text(match[2])) && match[1].startsWith("/events/"),
  );
function savedReview(html) {
  const links = reviewAnchors(html);
  expect(
    links.map((match) => match[1]),
    "one key-only saved-event review link",
  ).toEqual([`/events/${KEY}`]);
  const section = [...html.matchAll(/<(section|aside)\b[^>]*>[\s\S]*?<\/\1>/g)]
    .map((match) => match[0])
    .find((candidate) => reviewAnchors(candidate).length > 0);
  expect(section, "keep provenance and advice near the review action").toBeDefined();
  const copy = text(section);
  expect(copy).toMatch(/saved|persisted/i);
  expect(copy).toMatch(/unsaved|not (?:yet )?saved/i);
  expect(copy).toMatch(/publish/i);
  expect(copy).toMatch(/not include|not included|do(?:es)? not include|only .*saved|saved .*only/i);
  expect(section).toContain(`datetime="${UPDATED.toISOString()}"`);
  expect(copy).toMatch(/updated|last saved|saved at/i);
  expect(copy).not.toMatch(/(?:preview|review) (?:checked|verified) at/i);
  return section;
}
function correction(html, section, field) {
  const links = [...section.matchAll(/href="([^"]*#[^"]+)"/g)];
  const controls = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/g)].map((match) => match[0]);
  const valid = links.some(([, href]) => {
    const url = new URL(href.replaceAll("&amp;", "&"), `${ORIGIN}/admin/events/${KEY}`);
    const id = decodeURIComponent(url.hash.slice(1));
    return (
      url.pathname === `/admin/events/${KEY}` &&
      controls.some(
        (control) => control.includes(`id="${id}"`) && control.includes(`name="${field}"`),
      )
    );
  });
  expect(valid, `advice links to the existing ${field} correction field`).toBe(true);
}
async function editor(engine) {
  const response = await fixture.editorResponse(engine);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.text();
}
beforeAll(async () => {
  fixture = await savedEventFixture();
});
afterAll(async () => {
  await fixture?.dispose();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await fixture.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

for (const engine of ["Hono", "Kit"]) {
  describe(`${engine}: actual dispatch/load/SSR saved review without JavaScript`, () => {
    it("positive control: renders the saved fields and separate Save/Publish forms", async () => {
      await fixture.seed();
      const html = await editor(engine);
      expect(html).toContain(FIELDS.title);
      expect(html).toContain(FIELDS.location);
      const publish = html.match(
        new RegExp(`<form[^>]*action="/admin/events/${KEY}/publish"[^>]*>[\\s\\S]*?</form>`),
      )?.[0];
      expect(publish).toBeDefined();
      expect(publish).not.toMatch(/name="(?:title|location|ends_at)"/);
      expect(html).toContain(`action="/admin/events/${KEY}"`);
    });
    it.each(["draft", "published", "cancelled"])(
      "reviews the saved %s record with its actual updated time",
      async (status) => {
        await fixture.seed({ status });
        const html = await editor(engine);
        savedReview(html);
        expect(html.includes(`action="/admin/events/${KEY}/publish"`)).toBe(status === "draft");
      },
    );
    it.each([null, "", " \t "])(
      "flags blank saved location %j and provides a correction link",
      async (location) => {
        await fixture.seed({ location });
        const html = await editor(engine);
        const section = savedReview(html);
        expect(text(section)).toMatch(/location/i);
        expect(text(section)).toMatch(/add|missing|required|blank/i);
        correction(html, section, "location");
        const publish = html.match(/<form[^>]*action="[^"]*\/publish"[^>]*>[\s\S]*?<\/form>/)?.[0];
        expect(publish).not.toMatch(/\bdisabled(?:=|\s|>)/);
      },
    );
    it.each([
      { label: "one millisecond before end", delta: 1, ended: false },
      { label: "exact end equality", delta: 0, ended: false },
      { label: "one millisecond after end", delta: -1, ended: true },
    ])("strict advisory end boundary: $label", async ({ delta, ended }) => {
      await fixture.seed({ endsAt: new Date(NOW.getTime() + delta) });
      const html = await editor(engine);
      const section = savedReview(html);
      if (ended) {
        expect(text(section)).toMatch(/already ended|has ended|end.*past/i);
        correction(html, section, "ends_at");
      } else {
        expect(text(section)).toMatch(/ready|checks? pass|no .*issues/i);
        expect(text(section)).not.toMatch(/not (?:yet )?ready|cannot (?:be )?publish/i);
        expect(text(section)).not.toMatch(/already ended|has ended|end.*past/i);
      }
    });
    it("new unsaved forms have no nonexistent preview or Publish action", async () => {
      // /new remains shared Hono ownership, not an invented Kit mutation/page.
      const response =
        engine === "Hono" ? await fixture.honoGet("/events/new") : await fixture.newResponse();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(reviewAnchors(html)).toEqual([]);
      expect(html).not.toContain('/publish"');
    });
  });
}

describe("shared Hono writes retain publication authority", () => {
  it.each([
    { label: "blank saved location", change: { location: "  " }, error: /location/i },
    {
      label: "ended after rendering",
      change: { endsAt: new Date(NOW.getTime() - 1) },
      error: /ended/i,
    },
    {
      label: "cancelled after rendering",
      change: { status: "cancelled" },
      error: /cancel|draft|publish/i,
    },
  ])("rechecks $label despite earlier ready values", async ({ change, error }) => {
    await fixture.seed();
    await editor("Hono");
    await fixture.change(change);
    const before = await fixture.stored();
    const response = await fixture.post(`/events/${KEY}/publish`, {
      title: "FORGED draft",
      location: "Forged location",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(error);
    expect(await fixture.stored()).toEqual(before);
  });
  it.each([-1, 0, 1])("server end boundary at offset %i ms remains strict", async (delta) => {
    await fixture.seed({ endsAt: new Date(NOW.getTime() + delta) });
    const response = await fixture.post(`/events/${KEY}/publish`);
    expect(response.status).toBe(delta < 0 ? 422 : 303);
    expect((await fixture.stored()).status).toBe(delta < 0 ? "draft" : "published");
  });
  it("Publish ignores unsaved field payloads and publishes only saved fields", async () => {
    await fixture.seed();
    const response = await fixture.post(`/events/${KEY}/publish`, {
      title: "UNSAVED title",
      location: "UNSAVED location",
    });
    expect(response.status).toBe(303);
    expect(await fixture.stored()).toMatchObject({
      title: FIELDS.title,
      location: FIELDS.location,
      status: "published",
    });
  });
  it("rechecks time after waiting for the saved row lock", async () => {
    await fixture.seed({ endsAt: new Date(NOW.getTime() + 1) });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let locked;
    const ready = new Promise((resolve) => {
      locked = resolve;
    });
    const holder = fixture.client.begin(async (tx) => {
      const [{ pid }] = await tx`select pg_backend_pid() as pid`;
      await tx`select id from events where event_key = ${KEY} for update`;
      locked(pid);
      await gate;
    });
    const pid = await ready;
    let publication;
    let waiting = false;
    try {
      publication = fixture.post(`/events/${KEY}/publish`);
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline) {
        const [{ n }] =
          await fixture.client`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
        if (n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      vi.setSystemTime(new Date(NOW.getTime() + 2));
    } finally {
      release();
      await holder;
    }
    const response = await publication;
    expect(waiting, "prove Publish actually waited for this fixture's lock").toBe(true);
    expect(response.status).toBe(422);
    expect((await fixture.stored()).status).toBe("draft");
  });
  it("a rejected Save retains the draft but reviews the previous saved version", async () => {
    await fixture.seed();
    const before = await fixture.stored();
    const response = await fixture.post(`/events/${KEY}`, {
      ...FIELDS,
      title: "Rejected unsaved title",
      ends_at: "bad date",
      location: "UNSAVED location",
    });
    expect(response.status).toBe(422);
    expect(await fixture.stored()).toEqual(before);
    const html = await response.text();
    expect(html).toContain("Rejected unsaved title");
    expect(html).toContain("UNSAVED location");
    expect(html).toContain("data-event-draft");
    const section = savedReview(html);
    expect(text(section)).not.toContain("UNSAVED location");
  });
});

for (const engine of ["Hono", "Kit"]) {
  describe(`${engine}: draft detail remains moderator-only`, () => {
    it.each(["guest", "member", "moderator"])("%s visibility", async (role) => {
      await fixture.seed();
      const response = await fixture.detailResponse(engine, role);
      expect(response.status).toBe(role === "moderator" ? 200 : 403);
      const html = await response.text();
      if (role === "moderator") expect(html).toContain(FIELDS.title);
      else expect(html).not.toContain(FIELDS.title);
    });
  });
}
it.each(["guest", "member", "moderator"])(
  "key-only /events review URL preserves %s access",
  async (role) => {
    await fixture.seed();
    const response = await fixture.detailResponse("Hono", role, `/events/${KEY}`);
    expect(response.status).toBe(role === "guest" ? 302 : role === "moderator" ? 200 : 403);
    const html = await response.text();
    if (role === "moderator") expect(html).toContain(FIELDS.title);
    else expect(html).not.toContain(FIELDS.title);
  },
);
