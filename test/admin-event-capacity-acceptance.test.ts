// Event capacity, explained before Save: the saved-event edit twins show a
// Going-only occupied-seat snapshot beside the bare capacity input, advise on
// the proposed cap without ever reserving seats, and link the existing
// Going-only roster drilldown. The locked save, its below-occupancy refusal,
// waitlist promotion and stale-draft preservation stay exactly as they are.
//
// Case legend: ECC-01..08 are the discriminating RED cases (they fail on the
// pre-feature twins: no snapshot, no advice, no drilldown, no aggregate).
// ECC-C01..C06 are already-passing CONTROL cases the builder must keep green.
// Run: npx vitest run test/admin-event-capacity-acceptance.test.ts
//
// Ownership: this file and test/helpers/admin-event-capacity.ts.
// Builder contract (stable seams this file pins):
// - `data-testid="capacity-snapshot"`: Going-only occupied tally, saved
//   capacity (or Unlimited), and explicit snapshot wording, inside the
//   capacity field block. Carries data-occupied="<n>" and
//   data-capacity="<m>" (finite) for the progressive island.
// - `data-testid="capacity-advice"`: saved-state guidance (remaining / full /
//   unlimited) plus the valid-range hint; aria-live polite host the island
//   updates as the moderator types. Never rewrites the input, never disables
//   Save, never claims a guaranteed save or reservation.
// - `Review Going responses`: native anchor to the existing roster-status URL
//   (roster_status=going, page reset, #rsvp-roster).
// - The progressive island is discovered, not named: among the scripts the
//   page serves, the one that reads data-occupied/capacity-advice must be
//   served by BOTH twins, react to input events only (no setInterval, no
//   roster/capacity fetch), and follow the typing matrix in ECC-08.
// - The page-load aggregate is one bounded classified count(*) over rsvps,
//   scoped to the event and Going-only, with no member search and no new
//   identities; its SQL shape is asserted structurally, not by string pin.
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit";
import { listRoster } from "../src/admin/reads";
import { adminApp } from "../src/admin/routes";
import { getEvent } from "../src/admin/store-event-reads";
import { CAPACITY_BELOW_GOING } from "../src/events/waitlist";
import { createMemorySessionStore } from "../src/sessions";
import {
  capacityDb,
  capacityField,
  compileCapacityKit,
  isGoingAggregate,
  key,
  path,
  root,
  type CapacityFixture,
  type CapacityKit,
} from "./helpers/admin-event-capacity";
import {
  links,
  needle,
  readRoster,
  rosterHtml,
  subjects,
  text,
  type Renderer,
} from "./helpers/admin-roster-status";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

let kit: CapacityKit;
beforeAll(async () => {
  kit = await compileCapacityKit();
}, 120000);

const qs = (values: Record<string, string>) => new URLSearchParams(values).toString();
const aggregates = (fixture: CapacityFixture) =>
  fixture.statements.filter((s) => isGoingAggregate(s.sql, s.params));

function normalizedDrill(href: string) {
  const url = new URL(href, "https://next.example.test");
  expect(url.pathname).toBe(path);
  expect(url.hash).toBe("#rsvp-roster");
  return url.searchParams;
}

function snapshotText(field: string): string {
  const el = field.match(/<[^>]*data-testid="capacity-snapshot"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1];
  expect(el, "capacity snapshot element is missing beside the capacity input").toBeDefined();
  return text(el!);
}

function adviceText(field: string): string {
  const el = field.match(/<[^>]*data-testid="capacity-advice"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1];
  expect(el, "capacity advice element is missing beside the capacity input").toBeDefined();
  return text(el!);
}

/** The capacity input's aria-describedby tokens, exactly as a screen reader
 * resolves them. Throws when the input or the attribute is absent. */
function describedBy(field: string): string {
  const input = field.match(/<input\b[^>]*name="capacity"[^>]*>/)?.[0];
  expect(input, "capacity input is missing").toBeDefined();
  const value = input!.match(/\baria-describedby="([^"]*)"/)?.[1];
  expect(value, "capacity input has no aria-describedby").toBeDefined();
  return value!;
}

const FORM = {
  title: "Fixture game night",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "UTC",
  location: "Saved room",
};

async function postCapacity(fixture: CapacityFixture, capacity: string) {
  const store = createMemorySessionStore();
  const cookie = await cookieFor(store, MODERATOR);
  const body = new URLSearchParams({ ...FORM, capacity }).toString();
  return adminApp({ sessionStore: store, db: fixture.db }).request(
    `/events/${key}`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    { ...env, ADMIN_DB: fixture.db },
  );
}

for (const twin of ["Hono", "Kit"] as const satisfies Renderer[]) {
  describe(`ECC paired ${twin}: occupied seats explained before Save`, () => {
    it("ECC-01 shows the Going-only snapshot from one bounded aggregate, independent of roster search/status/page", async () => {
      const fixture = capacityDb({ capacity: 8, going: 3, maybe: 2, waitlisted: 2, notGoing: 1 });
      const response = await readRoster(
        twin,
        fixture,
        qs({
          roster_status: "maybe",
          roster_q: needle,
          roster_sort: "status",
          roster_order: "asc",
        }),
        kit,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const html = await response.text();
      const field = capacityField(html);
      const snapshot = snapshotText(field);
      expect(snapshot).toContain("3");
      expect(snapshot).toMatch(/snapshot/i);
      expect(snapshot).toContain("8");
      // The roster below stays the filtered Maybe page: occupancy never
      // follows the facet, the search, the sort or the page.
      const section = rosterHtml(html);
      expect(text(section)).toMatch(/of 2\b/);
      expect(text(section)).toMatch(/responses/i);
      // Exactly one bounded classified aggregate: count(*) only, scoped to
      // this event, Going-only, no member search, no identities.
      const reads = aggregates(fixture);
      expect(reads).toHaveLength(1);
      expect(reads[0]!.sql).toMatch(/^select count\(\*\) /);
      expect(reads[0]!.fields).toEqual(["n"]);
      expect(reads[0]!.sql).not.toMatch(/limit|offset|group by|union|order by/i);
      expect(reads[0]!.sql).not.toContain('"users"');
      expect(reads[0]!.params).toContain("going");
      const scope = reads[0]!.params.find((p) => p === key || p === 17);
      expect(scope, "aggregate is scoped to this event").toBeDefined();
      expect(reads[0]!.params.filter((p) => p !== scope)).toEqual(["going"]);
      // No new identities: the only subjects are the filtered roster page.
      expect(subjects(fixture)).toHaveLength(2);
      expect(fixture.audits).toHaveLength(1);
      expect(fixture.mutations).toBe(0);
    });

    it("ECC-02 unlimited saved cap shows occupancy with the Unlimited state", async () => {
      const fixture = capacityDb({ capacity: null, going: 3 });
      const response = await readRoster(twin, fixture, "", kit);
      expect(response.status).toBe(200);
      const snapshot = snapshotText(capacityField(await response.text()));
      expect(snapshot).toContain("3");
      expect(snapshot).toMatch(/unlimited/i);
      expect(snapshot).toMatch(/snapshot/i);
      expect(aggregates(fixture)).toHaveLength(1);
      expect(fixture.mutations).toBe(0);
    });

    it("ECC-03 zero Going with Maybe/Waitlist-only answers is an explicit zero, not an outage", async () => {
      const fixture = capacityDb({
        capacity: 8,
        going: 0,
        maybe: 2,
        waitlisted: 1,
        notGoing: 0,
      });
      const response = await readRoster(twin, fixture, "", kit);
      expect(response.status).toBe(200);
      const field = capacityField(await response.text());
      const snapshot = snapshotText(field);
      expect(snapshot).toMatch(/\b0\b/);
      expect(snapshot).toContain("8");
      expect(snapshot).toMatch(/snapshot/i);
      expect(text(field)).not.toMatch(/unavailable|could not load/i);
      expect(aggregates(fixture)).toHaveLength(1);
    });

    it("ECC-04 a degraded aggregate never fabricates zero or availability", async () => {
      const fixture = capacityDb({ aggregateFails: true });
      const response = await readRoster(twin, fixture, "", kit);
      if (response.status === 503) {
        expect(response.headers.get("cache-control")).toContain("no-store");
        const body = await response.text();
        expect(body).not.toContain(needle);
        expect(body).not.toContain('data-testid="rsvp-roster"');
        expect(body).not.toContain('data-testid="capacity-snapshot"');
        return;
      }
      expect(response.status).toBe(200);
      const html = await response.text();
      const field = capacityField(html);
      expect(text(field)).toMatch(/unavailable|could not load|try again/i);
      expect(text(field)).not.toMatch(/\d+\s*(of\s*\d+\s*)?(seats?|going)\s*occup/i);
      expect(text(field)).not.toMatch(/seats? (left|available|remaining)/i);
      const snapshot = field.match(
        /<[^>]*data-testid="capacity-snapshot"[^>]*>([\s\S]*?)<\/[^>]+>/,
      )?.[1];
      if (snapshot !== undefined) {
        expect(text(snapshot)).toMatch(/unavailable|could not load|try again/i);
        expect(text(snapshot)).not.toMatch(/\b\d+\b.*occup|\boccup.*\b\d+\b/i);
      }
      expect(fixture.mutations).toBe(0);
    });

    it("ECC-05 nameless Going rows occupy seats exactly like the locked guard counts them", async () => {
      const fixture = capacityDb({ capacity: 8, going: 2, namelessGoing: 1 });
      const response = await readRoster(twin, fixture, "", kit);
      expect(response.status).toBe(200);
      const html = await response.text();
      // The guard counts every Going row; the snapshot must agree or its
      // advice greenlights a cap the save then refuses.
      expect(snapshotText(capacityField(html))).toContain("3");
      expect(text(rosterHtml(html))).toContain("Unknown member");
      expect(aggregates(fixture)).toHaveLength(1);
    });

    it.each<[string, { capacity: number | null; going: number }, RegExp, RegExp | null]>([
      ["below", { capacity: 8, going: 3 }, /5 of 8/i, /left|remaining/i],
      ["full", { capacity: 3, going: 3 }, /full/i, null],
      ["unlimited", { capacity: null, going: 3 }, /unlimited/i, null],
    ])(
      "ECC-06 saved-state advice explains the %s cap without touching the input",
      async (_state, opts, primary, secondary) => {
        const fixture = capacityDb(opts);
        const response = await readRoster(twin, fixture, "", kit);
        expect(response.status).toBe(200);
        const html = await response.text();
        const field = capacityField(html);
        const advice = adviceText(field);
        expect(advice).toMatch(primary);
        if (secondary) expect(advice).toMatch(secondary);
        // The no-JS view still teaches the valid range.
        expect(text(field)).toMatch(/1 to 2147483647/);
        // The progressive host: snapshot data for the island, announced
        // politely, input and retry left alone.
        const host = field.match(/<[^>]*data-testid="capacity-advice"[^>]*>/)![0]!;
        expect(host).toMatch(/aria-live="polite"|role="status"/);
        const source = field.match(/<[^>]*data-testid="capacity-snapshot"[^>]*>/)![0]!;
        expect(source).toContain('data-occupied="3"');
        if (opts.capacity === null) expect(source).not.toMatch(/data-capacity="[0-9]/);
        else expect(source).toContain(`data-capacity="${opts.capacity}"`);
        const input = field.match(/<input\b[^>]*name="capacity"[^>]*>/)![0]!;
        expect(input).not.toMatch(/\bmin=|\bmax=|\bdisabled\b/);
        expect(input).toContain(opts.capacity === null ? 'value=""' : `value="${opts.capacity}"`);
        // Focusing the input must announce the Going snapshot and the advice,
        // in that order, on both twins.
        expect(describedBy(field)).toBe("capacity-snapshot capacity-advice");
        expect(html).not.toMatch(/<button\b[^>]*data-testid="save-event"[^>]*disabled/);
        expect(text(field)).not.toMatch(/guarantee|reserv/i);
      },
    );

    it("ECC-07 Review Going responses drills into the existing roster with honest seat copy", async () => {
      const fixture = capacityDb({ capacity: 8, going: 3 });
      const response = await readRoster(twin, fixture, "", kit);
      expect(response.status).toBe(200);
      const html = await response.text();
      const field = capacityField(html);
      const drill = links(field).find((l) => l.label === "Review Going responses");
      expect(drill, "native Review Going responses action is missing").toBeDefined();
      const state = normalizedDrill(drill!.href);
      expect(state.get("roster_status")).toBe("going");
      expect(state.get("roster_page") ?? "1").toBe("1");
      // Following it renders the Going-only first page through the existing
      // roster-status URL authority.
      const followed = await readRoster(
        twin,
        capacityDb({ capacity: 8, going: 3 }),
        state.toString(),
        kit,
      );
      expect(followed.status).toBe(200);
      const section = rosterHtml(await followed.text());
      expect(text(section)).toMatch(/of 3\b/);
      expect(text(section)).toMatch(/responses/i);
      // Seat copy: Maybe/Waitlist never occupy; a raise can promote; RSVP
      // responses are never labelled attendance.
      expect(text(field)).toMatch(/maybe/i);
      expect(text(field)).toMatch(/waitlist/i);
      expect(text(field)).toMatch(/(do not|don't|never) occupy/i);
      expect(text(field)).toMatch(/promot/i);
      expect(text(field)).not.toMatch(/\battendance\b|\battended\b|\battendees?\b/i);
      expect(text(section)).not.toMatch(/\battendance\b|\battended\b/i);
      // No polling and no silent reservation machinery anywhere on the page.
      expect(html).not.toMatch(/<meta\b[^>]*http-equiv="refresh"/i);
      for (const src of [...html.matchAll(/<script\b[^>]*src="(\/islands\/[^"]+\.js)"[^>]*>/g)].map(
        (m) => m[1]!,
      )) {
        const shipped = readFileSync(join(root, "public", src), "utf8");
        expect(shipped).not.toContain("setInterval");
        expect(shipped).not.toMatch(/fetch\s*\(\s*["'`/].*(roster|capacity|rsvp)/i);
      }
    });

    it("ECC-C01 CONTROL roster totals stay filtered response counts, never seats", async () => {
      const fixture = capacityDb({ capacity: 8, going: 3 });
      const response = await readRoster(twin, fixture, qs({ roster_status: "maybe" }), kit);
      expect(response.status).toBe(200);
      const section = rosterHtml(await response.text());
      expect(text(section)).toMatch(/of 2\b/);
      expect(text(section)).toMatch(/responses/i);
      expect(text(section)).not.toMatch(/\bseats?\b/i);
    });

    it.each(["guest", "member"] as const)(
      "ECC-C02 CONTROL %s is refused before any protected SQL",
      async (admission) => {
        const fixture = capacityDb();
        const response = await readRoster(twin, fixture, "", kit, admission);
        expect(response.status).toBe(admission === "guest" ? 302 : 403);
        expect(fixture.statements).toEqual([]);
      },
    );

    it("ECC-C03 CONTROL failed audit still refuses the whole buffered render without mutations", async () => {
      const fixture = capacityDb({ auditFails: true });
      const response = await readRoster(twin, fixture, "", kit);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const html = await response.text();
      expect(html).not.toMatch(/Café|Unknown member|data-testid="rsvp-roster"/);
      expect(
        fixture.statements.filter((s) => s.sql.startsWith('insert into "member_data_access_logs"')),
      ).toHaveLength(1);
      expect(fixture.mutations).toBe(0);
    });
  });
}

describe("ECC-06 error state: the capacity description keeps snapshot, advice and error together", () => {
  const message = "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.";

  it("Kit keeps all three references, error last, and flags the input invalid", async () => {
    // The Kit load never originates a field error: the 422 re-render after a
    // refused save is Hono-owned, so the Kit page renders a refused draft from
    // the load-shaped view (the admin validation-correction precedent). The
    // view itself comes from the real resolver over the fixture reads.
    const fixture = capacityDb({ capacity: 8, going: 3 });
    const outcome = await resolveKitEventEdit(
      key,
      {},
      {
        db: fixture.db,
        get: getEvent,
        list: (d, k, q) => listRoster(d, k, q, { occupied: true }),
      },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = kit.html({
      view: {
        ...outcome.view,
        values: { ...outcome.view.values, capacity: "abc" },
        errors: { capacity: message },
        hasErrors: true,
        isDraft: true,
      },
    });
    const field = capacityField(html);
    expect(describedBy(field)).toBe("capacity-snapshot capacity-advice f-capacity-error");
    const input = field.match(/<input\b[^>]*name="capacity"[^>]*>/)![0]!;
    expect(input).toContain('aria-invalid="true"');
    const error = field.match(/<p[^>]*data-testid="error-capacity"[^>]*>([\s\S]*?)<\/p>/)![1]!;
    expect(text(error)).toBe(message);
  });

  it("Hono refused-save re-render resolves cleanly: the panel is absent, so only the error is described", async () => {
    // Invariant a screen reader depends on: every token names a node that is
    // rendered. The Hono 422 re-render carries no fresh aggregate, so it
    // renders no panel and the field helper describes only its error. If the
    // re-render ever grows a snapshot, this case fails first: re-pin the
    // three-token shape here instead of describing nodes that are not on the page.
    const fixture = capacityDb({ status: "draft", capacity: 8, going: 3 });
    const response = await postCapacity(fixture, "abc");
    expect(response.status).toBe(422);
    const field = capacityField(await response.text());
    expect(field).not.toContain('data-testid="capacity-snapshot"');
    expect(field).not.toContain('data-testid="capacity-advice"');
    expect(describedBy(field)).toBe("f-capacity-error");
    const input = field.match(/<input\b[^>]*name="capacity"[^>]*>/)![0]!;
    expect(input).toContain('aria-invalid="true"');
    const error = field.match(/<p[^>]*data-testid="error-capacity"[^>]*>([\s\S]*?)<\/p>/)![1]!;
    expect(text(error)).toBe(message);
  });
});

describe("ECC Hono POST: the locked save keeps the last word", () => {
  it("ECC-C04 CONTROL an RSVP landing after the snapshot still refuses under lock with the draft kept", async () => {
    const fixture = capacityDb({
      status: "draft",
      capacity: 2,
      going: 2,
      maybe: 0,
      waitlisted: 0,
      notGoing: 0,
    });
    fixture.landGoing();
    const response = await postCapacity(fixture, "2");
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Check the highlighted fields and try again.");
    const error = html.match(/<p[^>]*data-testid="error-capacity"[^>]*>([\s\S]*?)<\/p>/)![1]!;
    expect(text(error)).toContain(CAPACITY_BELOW_GOING);
    expect(text(error)).toContain("Occupied seats: 3");
    // Stale-draft preservation: the refused value stays editable, retry stays enabled.
    expect(html).toMatch(/<input\b[^>]*name="capacity"[^>]*value="2"/);
    expect(html).toMatch(/<button\b[^>]*data-testid="save-event"[^>]*>/);
    expect(html).not.toMatch(/<button\b[^>]*data-testid="save-event"[^>]*disabled/);
    expect(fixture.mutations).toBe(0);
  });

  it.each(["3", "8"])(
    "ECC-C05 CONTROL a cap at/above occupancy still saves (303): %s",
    async (capacity) => {
      const fixture = capacityDb({
        status: "draft",
        capacity: 2,
        going: 3,
        maybe: 0,
        waitlisted: 0,
        notGoing: 0,
      });
      const response = await postCapacity(fixture, capacity);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/admin/events/${key}`);
    },
  );

  it("ECC-C05 CONTROL raising the cap still promotes the waitlist in FIFO order", async () => {
    const fixture = capacityDb({
      status: "published",
      capacity: 3,
      going: 3,
      maybe: 0,
      waitlisted: 2,
      notGoing: 0,
    });
    const response = await postCapacity(fixture, "8");
    expect(response.status).toBe(303);
    expect(fixture.promoted).toHaveLength(2);
  });

  it.each(["0", "-3", "abc", "2.5", "2147483648", "99999999999999999999999"])(
    "ECC-C06 CONTROL invalid capacity %j still 422s with the draft kept",
    async (capacity) => {
      const fixture = capacityDb({ status: "draft" });
      const response = await postCapacity(fixture, capacity);
      expect(response.status).toBe(422);
      const html = await response.text();
      const error = html.match(/<p[^>]*data-testid="error-capacity"[^>]*>([\s\S]*?)<\/p>/)![1]!;
      expect(text(error)).toBe(
        "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.",
      );
      expect(html).toContain(`value="${capacity}"`);
      expect(fixture.mutations).toBe(0);
    },
  );
});

describe("ECC-08 progressive island: the proposed cap explained as it is typed", () => {
  function fakeCapacityDom() {
    type Listener = (event: { type: string; target: FakeElement }) => void;
    type FakeElement = {
      id: string;
      testid: string | null;
      value: string;
      textContent: string;
      attrs: Record<string, string>;
      listeners: Map<string, Listener[]>;
      addEventListener: (kind: string, fn: Listener) => void;
      getAttribute: (name: string) => string | null;
      setAttribute: (name: string, value: string) => void;
      removeAttribute: (name: string) => void;
    };
    const make = (
      id: string,
      testid: string | null,
      attrs: Record<string, string> = {},
    ): FakeElement => ({
      id,
      testid,
      value: "",
      textContent: "",
      attrs: { ...attrs },
      listeners: new Map(),
      addEventListener(kind, fn) {
        const el = elements.find((e) => e.id === id)!;
        el.listeners.set(kind, [...(el.listeners.get(kind) ?? []), fn]);
      },
      getAttribute: (name) => elements.find((e) => e.id === id)!.attrs[name] ?? null,
      setAttribute: (name, value) => {
        elements.find((e) => e.id === id)!.attrs[name] = value;
      },
      removeAttribute: (name) => {
        delete elements.find((e) => e.id === id)!.attrs[name];
      },
    });
    const elements = [
      make("f-capacity", null),
      make("capacity-snapshot", "capacity-snapshot", {
        "data-occupied": "3",
        "data-capacity": "8",
      }),
      make("capacity-advice", "capacity-advice", { "aria-live": "polite" }),
      make("save-event", "save-event"),
    ];
    const byId = Object.fromEntries(elements.map((e) => [e.id, e]));
    const fetches: unknown[][] = [];
    const intervals: unknown[][] = [];
    const find = (selector: string) => {
      if (selector.startsWith("#")) return byId[selector.slice(1)] ?? null;
      const testid = selector.match(/data-testid="([^"]+)"/)?.[1];
      const name = selector.match(/\[name="([^"]+)"\]/)?.[1];
      if (name === "capacity") return byId["f-capacity"]!;
      return elements.find((e) => e.testid === testid) ?? null;
    };
    const doc = {
      readyState: "complete",
      getElementById: (id: string) => byId[id] ?? null,
      querySelector: find,
      querySelectorAll: (selector: string) => {
        const one = find(selector);
        return one ? [one] : [];
      },
      addEventListener: () => {},
    };
    return {
      input: byId["f-capacity"]!,
      advice: byId["capacity-advice"]!,
      save: byId["save-event"]!,
      fetches,
      intervals,
      document: doc,
      type(value: string) {
        const input = byId["f-capacity"]!;
        input.value = value;
        for (const fn of input.listeners.get("input") ?? []) fn({ type: "input", target: input });
      },
      sandbox(extra: Record<string, unknown> = {}) {
        return {
          document: doc,
          window: { document: doc, addEventListener: () => {} },
          fetch: (...args: unknown[]) => {
            fetches.push(args);
            throw new Error("island must not fetch");
          },
          setInterval: (...args: unknown[]) => {
            intervals.push(args);
            throw new Error("island must not poll");
          },
          ...extra,
        };
      },
    };
  }

  async function discoverDriver(): Promise<{ src: string; shipped: string }> {
    const hono = await readRoster("Hono", capacityDb({ capacity: 8, going: 3 }), "", kit);
    expect(hono.status).toBe(200);
    const honoHtml = await hono.text();
    const served = [...honoHtml.matchAll(/<script\b[^>]*src="(\/islands\/[^"]+\.js)"[^>]*>/g)].map(
      (m) => m[1]!,
    );
    expect(served.length).toBeGreaterThan(0);
    const src = served.find((candidate) => {
      const shipped = readFileSync(join(root, "public", candidate), "utf8");
      return shipped.includes("capacity-advice") || shipped.includes("data-occupied");
    });
    expect(src, "a served island must progressively explain the proposed capacity").toBeDefined();
    // The Kit twin serves the same progressive enhancement.
    const kitHtml = await (
      await readRoster("Kit", capacityDb({ capacity: 8, going: 3 }), "", kit)
    ).text();
    expect(kitHtml).toContain(src!);
    const shipped = readFileSync(join(root, "public", src!), "utf8");
    expect(shipped).not.toContain("setInterval");
    return { src: src!, shipped };
  }

  it("discovers one served island that both twins share and drives the typing matrix", async () => {
    const { shipped } = await discoverDriver();
    const dom = fakeCapacityDom();
    dom.input.value = "8";
    runInNewContext(shipped, dom.sandbox());
    const matrix: [string, RegExp][] = [
      ["", /unlimited/i],
      ["8", /5 of 8/i],
      ["10", /7 of 10|7\b.*(left|remaining)/i],
      ["3", /full/i],
      ["2", /below|already going|occupied/i],
      ["abc", /valid|headcount|2147483647/i],
      ["0", /valid|headcount|2147483647/i],
      ["-1", /valid|headcount|2147483647/i],
      ["2.5", /valid|headcount|2147483647/i],
      ["2147483648", /valid|headcount|2147483647/i],
      ["99999999999999999999999", /valid|headcount|2147483647/i],
    ];
    for (const [value, expected] of matrix) {
      dom.type(value);
      expect(dom.input.value, `island rewrote the proposed cap ${JSON.stringify(value)}`).toBe(
        value,
      );
      expect(dom.advice.textContent, `proposed cap ${JSON.stringify(value)}`).toMatch(expected);
      expect(dom.advice.textContent).not.toMatch(/guarantee|reserv/i);
      expect(dom.save.attrs["disabled"], "island disabled a legitimate retry").toBeUndefined();
    }
    expect(dom.fetches).toEqual([]);
    expect(dom.intervals).toEqual([]);
  });

  it.each<[string, RegExp]>([
    ["2", /below|already going|occupied/i],
    ["", /unlimited/i],
    ["10", /7 of 10|7\b.*(left|remaining)/i],
    ["abc", /valid|headcount|2147483647/i],
  ])(
    "explains a restored draft %j (saved cap 8) at load, before any input event",
    async (restored, expected) => {
      const { shipped } = await discoverDriver();
      const dom = fakeCapacityDom();
      // A browser restoring form state without bfcache re-fills the input
      // before the island runs and fires no input event. The advice must
      // still explain the restored value as soon as the island loads.
      dom.input.value = restored;
      runInNewContext(shipped, dom.sandbox());
      expect(dom.input.value).toBe(restored);
      expect(
        dom.advice.textContent,
        `restored draft ${JSON.stringify(restored)} against saved cap 8`,
      ).toMatch(expected);
      if (restored === "2") expect(dom.advice.textContent).not.toMatch(/5 of 8/i);
      expect(dom.advice.textContent).not.toMatch(/guarantee|reserv/i);
      expect(dom.save.attrs["disabled"]).toBeUndefined();
      expect(dom.fetches).toEqual([]);
      expect(dom.intervals).toEqual([]);
    },
  );

  it("leaves a restored value that equals the saved cap untouched at load", async () => {
    const { shipped } = await discoverDriver();
    const dom = fakeCapacityDom();
    dom.input.value = "8";
    runInNewContext(shipped, dom.sandbox());
    expect(dom.advice.textContent).toBe("");
  });
});
