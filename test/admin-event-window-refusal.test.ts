import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { serializeSigned } from "hono/utils/cookie";
import { adminApp } from "../src/admin/routes";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createPlanningWindowFixture,
  type PlanningWindowFixture,
} from "./helpers/admin-event-planning-window-db";
import {
  eventListParams,
  parseEventListQuery,
  parseEventStartsWindow,
} from "../src/admin/event-list";
import { EventsPage } from "../src/admin/pages/events-list";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db";
import { compilePlanningWindowKit } from "./helpers/admin-event-planning-window";

it("keeps an independently valid singleton when the other date is duplicated", () => {
  expect(parseEventStartsWindow(["2032-02-28", "2032-02-29"], "2032-03-02")).toMatchObject({
    before: "2032-03-02",
    error: expect.stringContaining("only once"),
  });
  expect(parseEventStartsWindow("2032-02-29", ["2032-03-01", "2032-03-02"])).toMatchObject({
    from: "2032-02-29",
    error: expect.stringContaining("only once"),
  });
});

it.each(["1", "2", "3", "", "unknown", ["1", "1"]] as const)(
  "refuses an unsatisfied or malformed correction marker %j",
  (starts_required) => {
    expect(parseEventListQuery({ starts_required }).startsWindow?.error).toBeDefined();
  },
);
it("allows the originally optional opposite bound after correcting a sole rejected endpoint", () => {
  expect(
    parseEventListQuery({ starts_required: "1", starts_from: "2032-02-29" }).startsWindow,
  ).toEqual({ from: "2032-02-29" });
  expect(
    parseEventListQuery({ starts_required: "2", starts_before: "2032-03-02" }).startsWindow,
  ).toEqual({ before: "2032-03-02" });
});

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
function elements(node: Node): Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}
function filterForm(html: string): URLSearchParams {
  const form = elements(parseFragment(html)).find(
    (node) => node.tagName === "form" && attr(node, "action") === "/admin/events",
  );
  expect(form, "the actual native GET filter form").toBeDefined();
  expect(attr(form!, "method")).toBe("get");
  const params = new URLSearchParams();
  for (const control of elements(form!)) {
    const name = attr(control, "name");
    if (!name || attr(control, "disabled") !== undefined) continue;
    if (control.tagName === "input") params.append(name, attr(control, "value") ?? "");
    if (control.tagName === "select") {
      const options = elements(control).filter((node) => node.tagName === "option");
      const selected = options.find((node) => attr(node, "selected") !== undefined) ?? options[0];
      params.append(name, selected ? (attr(selected, "value") ?? "") : "");
    }
  }
  return params;
}

const refusals = [
  "starts_from=nope&starts_before=2032-03-02",
  "starts_from=2032-02-28&starts_from=2032-02-29&starts_before=2032-03-02",
  "starts_from=2032-02-29&starts_before=2032-03-02&starts_before=2032-03-03",
  "starts_from=2032-03-02&starts_before=2032-02-29",
  "starts_from=2032-03-02&starts_before=2032-03-02",
];

// Refused windows must return before touching any database method.
const env = {
  APP_URL: "https://fixture.example.test",
  ADMIN_DB: new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "then") return undefined;
        throw new Error("Unexpected database work for refused window");
      },
    },
  ) as Db,
} as EnvWithAdminDb;

const correctionCases = [
  ["starts_from=nope&starts_before=2032-03-02", "", "2032-03-02"],
  ["starts_from=2032-02-29&starts_before=nope", "2032-02-29", ""],
  ["starts_from=2032-02-28&starts_from=2032-02-29&starts_before=2032-03-02", "", "2032-03-02"],
  ["starts_from=2032-02-29&starts_before=2032-03-02&starts_before=2032-03-03", "2032-02-29", ""],
  ["starts_from=nope", "", ""],
  ["starts_before=nope", "", ""],
  ["starts_from=nope&starts_before=nope", "", ""],
  ["starts_from=2032-03-02&starts_before=2032-02-29", "2032-03-02", "2032-02-29"],
  ["starts_from=2032-03-02&starts_before=2032-03-02", "2032-03-02", "2032-03-02"],
] as const;

describe.each(["Hono", "Kit"] as const)("%s refused form round trip", (twin) => {
  let fixture: PlanningWindowFixture;
  let kit: Awaited<ReturnType<typeof compilePlanningWindowKit>>;
  let cookie: string;
  const store = createMemorySessionStore();
  const queries: { sql: string; params: unknown[] }[] = [];
  const bindings = { ...env, SESSION_SECRET: "fixture-session-secret-at-least-32-characters" };
  const request = (search: URLSearchParams) =>
    twin === "Kit"
      ? kit.request({
          env: { ...bindings, ADMIN_DB: fixture.db } as EnvWithAdminDb,
          path: `/admin/events?${search}`,
        })
      : adminApp({ sessionStore: store, db: fixture.db }).request(
          `/events?${search}`,
          { headers: { cookie } },
          { ...bindings, ADMIN_DB: fixture.db },
        );
  beforeAll(async () => {
    fixture = await createPlanningWindowFixture(queries);
    if (twin === "Kit") kit = await compilePlanningWindowKit();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000111",
      username: "Fixture moderator",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    cookie = (
      await serializeSigned("__Host-two_session", token, bindings.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    for (const [key, day] of [
      ["earlier", "2032-02-27"],
      ["inside", "2032-03-01"],
      ["after", "2032-03-03"],
    ]) {
      await fixture.insertEvent({
        eventKey: key!,
        title: key!,
        status: "published",
        startsAt: new Date(`${day}T12:00:00Z`),
        endsAt: new Date("2032-04-01T12:00:00Z"),
      });
    }
    queries.length = 0;
  });
  it.each(correctionCases)(
    "retains exact correction values and refuses unchanged Filter: %s",
    async (raw, from, before) => {
      const response = await request(new URLSearchParams(`${raw}&sort=starts_at&order=asc`));
      expect(response.status).toBe(200);
      const html = await response.text();
      const form = filterForm(html);
      expect([form.get("starts_from"), form.get("starts_before")]).toEqual([from, before]);
      const unchanged = await request(form);
      const refused = await unchanged.text();
      expect(unchanged.status).toBe(200);
      expect(refused).toContain('role="alert"');
      expect(refused).not.toContain('data-testid="event-status-');
      expect(queries.filter(({ sql }) => /from "events"/i.test(sql))).toHaveLength(0);
      const again = filterForm(refused);
      expect([again.get("starts_from"), again.get("starts_before")]).toEqual([from, before]);
      // Correct the bad endpoint(s); independently valid counterparts are not edited.
      if (from === "" || from >= (before || "9999-12-31")) again.set("starts_from", "2032-02-29");
      if (before === "" || before <= "2032-02-29") again.set("starts_before", "2032-03-02");
      const corrected = await (await request(again)).text();
      expect(corrected).not.toContain('role="alert"');
      expect(
        [...corrected.matchAll(/data-testid="event-status-([^"]+)"/g)].map((m) => m[1]),
      ).toEqual(["inside"]);
      expect(filterForm(corrected).has("starts_required")).toBe(false);
      const clear = elements(parseFragment(refused)).find(
        (node) =>
          node.tagName === "a" && attr(node, "href") === "/admin/events?sort=starts_at&order=asc",
      );
      expect(clear, "an explicit clear remains available").toBeDefined();
    },
  );
});

describe("refused UTC window navigation", () => {
  let kit: Awaited<ReturnType<typeof compilePlanningWindowKit>>;
  beforeAll(async () => {
    kit = await compilePlanningWindowKit();
  });

  for (const renderer of ["Hono", "Kit"] as const) {
    it.each(refusals)(
      `${renderer} offers explicit correction/clear, never an unfiltered sort or pager: %s`,
      async (raw) => {
        const search = new URLSearchParams(`${raw}&page=3`);
        const query = parseEventListQuery(eventListParams(search));
        let html: string;
        if (renderer === "Hono") {
          html = String(EventsPage({ query, rows: [], hasNext: false }));
        } else {
          const response = await kit.request({ env, path: `/admin/events?${search}` });
          expect(response.status).toBe(200);
          html = await response.text();
        }
        expect(html).toContain('role="alert"');
        expect(html).toContain("Clear filters</a>");
        expect(html).not.toContain('aria-label="Sort by');
        expect(html).not.toContain('rel="prev"');
        expect(html).not.toContain('rel="next"');
        expect(html).not.toContain("First page of these results</a>");
      },
    );
  }
});
