// TEST AUTHOR OWNED: Builder must not edit this file or its paired helper/spec.
// Stable AO-* IDs describe behavior, not a required component/class/copy choice.
// Removing current-section metadata, marking an ancestor as an exact page,
// choosing navigation from a title/query, or moving the up link below fields
// must fail. Existing route/status/escaping/Save contracts are controls.
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorPage, EventFormPage, FeaturedFormPage } from "../src/admin/pages";
import { parseEventListQuery } from "../src/admin/event-list";
import {
  parseActivityLogQuery,
  parseFeaturedListQuery,
  parseJoinAttemptsQuery,
} from "../src/admin/table-list";
import {
  compileOrientation,
  headerLinks,
  orientationForms,
  upperLinks,
  type AdminPage,
  type OrientationRenderer,
} from "./helpers/admin-orientation";
import { eventRow, featuredRow, type FormFixture } from "./helpers/admin-validation-correction";
import { EVENT_KEY, pageShellFixture } from "./helpers/page-shells";

let render: OrientationRenderer;
let forms: FormFixture[];
let rejected: FormFixture[];
beforeAll(async () => {
  render = await compileOrientation();
  forms = await orientationForms(render);
  rejected = await orientationForms(render, true);
});

const cases: {
  id: string;
  name: AdminPage;
  path: string;
  section: string;
  exact: boolean;
  data: unknown;
}[] = [
  {
    id: "dashboard",
    name: "dashboard",
    path: "/admin",
    section: "/admin",
    exact: true,
    data: { actor: { username: "Local moderator" }, retentionDays: 30 },
  },
  {
    id: "events-list",
    name: "events",
    path: "/admin/events",
    section: "/admin/events",
    exact: true,
    data: { query: parseEventListQuery({}), rows: [], hasNext: false, emptyText: "No events." },
  },
  {
    id: "events-filter",
    name: "events",
    path: "/admin/events?q=Featured&page=2",
    section: "/admin/events",
    exact: true,
    data: {
      query: parseEventListQuery({ q: "Featured", page: "2" }),
      rows: [],
      hasNext: false,
      emptyText: "No matches.",
    },
  },
  {
    id: "event-new",
    name: "eventNew",
    path: "/admin/events/new",
    section: "/admin/events",
    exact: false,
    data: {},
  },
  {
    id: "event-edit",
    name: "eventEdit",
    path: `/admin/events/${EVENT_KEY}`,
    section: "/admin/events",
    exact: false,
    data: {
      view: {
        title: "Featured content",
        key: EVENT_KEY,
        values: {},
        errors: {},
        status: "draft",
        showPublish: false,
        showCancel: false,
        rsvpAction: null,
        roster: {
          total: 0,
          query: {},
          sortHeaders: [],
          entries: [],
          emptyText: "No RSVPs.",
          hasPrev: false,
          hasNext: false,
        },
      },
    },
  },
  {
    id: "featured-list",
    name: "featured",
    path: "/admin/featured",
    section: "/admin/featured",
    exact: true,
    data: {
      query: parseFeaturedListQuery({}),
      rows: [],
      emptyText: "No slots.",
      positionHeader: {
        label: "Position",
        url: "/admin/featured?sort=position",
        active: true,
        order: "asc",
      },
      updatedHeader: {
        label: "Updated",
        url: "/admin/featured?sort=updated",
        active: false,
        order: "desc",
      },
    },
  },
  {
    id: "featured-new",
    name: "featuredNew",
    path: "/admin/featured/new",
    section: "/admin/featured",
    exact: false,
    data: {},
  },
  {
    id: "featured-edit",
    name: "featuredEdit",
    path: "/admin/featured/1",
    section: "/admin/featured",
    exact: false,
    data: {
      view: {
        id: 1,
        title: "Events",
        checkedAt: "2030-01-01T12:00:00Z",
        status: "draft",
        visible: false,
        values: {},
      },
    },
  },
  {
    id: "join-list",
    name: "joins",
    path: "/admin/join-attempts",
    section: "/admin/join-attempts",
    exact: true,
    data: {
      query: parseJoinAttemptsQuery({}),
      rows: [],
      outcomes: ["added"],
      retentionDays: 30,
      hasNext: false,
      prevUrl: null,
      nextUrl: null,
    },
  },
  {
    id: "join-detail",
    name: "joinDetail",
    path: "/admin/join-attempts/1",
    section: "/admin/join-attempts",
    exact: false,
    data: {
      view: {
        id: 1,
        outcome: "added",
        source: "join",
        requestId: "local-request",
        discordId: "123",
        createdAt: "2030-01-01T12:00:00Z",
      },
    },
  },
  {
    id: "activity-list",
    name: "activity",
    path: "/admin/activity-log",
    section: "/admin/activity-log",
    exact: true,
    data: { query: parseActivityLogQuery({}), rows: [], hasNext: false },
  },
];

// Exact roots identify the page; descendants identify their containing location.
// Loose truthy-token checks would miss an ancestor incorrectly claiming page.
function expectCurrent(html: string, section: string, exact: boolean) {
  const links = headerLinks(html);
  expect(links.length, "real moderator shell rendered").toBeGreaterThanOrEqual(6);
  const current = links.filter((link) => link.current && link.current !== "false");
  expect(
    current.map((link) => link.href),
    "exactly the intended section is current",
  ).toEqual([section]);
  expect(current[0]!.current, "exact page versus ancestor location token").toBe(
    exact ? "page" : "location",
  );
  expect([null, "false"]).toContain(links.find((link) => link.href === "/")?.current ?? null);
}

describe("AO-01: current location is truthful in both real shells", () => {
  for (const row of cases) {
    it(`AO-01 Hono ${row.id}`, async () => {
      const res = await pageShellFixture().request(row.path);
      expect(res.status).toBe(200);
      expectCurrent(await res.text(), row.section, row.exact);
    });
    it(`AO-01 Kit ${row.id}`, () => {
      const html = render(row.name, row.path, row.data).body;
      expectCurrent(html, row.section, row.exact);
    });
    it(`AO-02 CONTROL ${row.id}: shell destinations stay fixed and no-JS capable`, async () => {
      const res = await pageShellFixture().request(row.path);
      expect(res.status).toBe(200);
      for (const html of [await res.text(), render(row.name, row.path, row.data).body]) {
        const links = headerLinks(html);
        for (const href of [
          "/admin",
          "/admin/events",
          "/admin/featured",
          "/admin/join-attempts",
          "/admin/activity-log",
          "/",
        ]) {
          expect(links.filter((link) => link.href === href).length, href).toBeGreaterThanOrEqual(1);
        }
        expect(html).toContain('id="main"');
      }
    });
    it(`AO-03 ${row.id}: both renderers use the same current-location semantics`, async () => {
      const res = await pageShellFixture().request(row.path);
      const selected = (link: { href: string; current: string | null }) =>
        link.href === row.section && !!link.current && link.current !== "false";
      const hono = headerLinks(await res.text()).find(selected);
      const kit = headerLinks(render(row.name, row.path, row.data).body).find(selected);
      expect(hono?.current, "a missing marker in both renderers is not parity").toBeTruthy();
      expect(kit?.current).toBe(hono?.current);
    });
  }
});

// Walk original markup only: hydration comments end at the first -->.
// Keep all other bytes (including malformed comments and element tags), so
// exact-name assertions still reject them. Never parse the joined label as HTML.
function breadcrumbLabel(markup: string): string {
  let index = 0;
  let label = "";
  while (index < markup.length) {
    if (markup.startsWith("<!--", index)) {
      const end = markup.indexOf("-->", index + 4);
      if (end !== -1) {
        index = end + 3;
        continue;
      }
    }
    const next = markup.indexOf("<", index + 1);
    const end = next === -1 ? markup.length : next;
    label += markup.slice(index, end);
    index = end;
  }
  return label.trim();
}

describe("AO-04/AO-06 CONTROL: breadcrumb labels ignore only original comment tokens", () => {
  it.each([
    ["Dashboard", "Dashboard"],
    ["  <!--[-->Dashboard<!--]-->  ", "Dashboard"],
    ["<!---->Events<!---->", "Events"],
    ["<!--svelte-->Fea<!---->tured<!--/svelte-->", "Featured"],
    ["<!-- outer <!-- nested-looking -->Dashboard", "Dashboard"],
    ["Dashboard<!-- outer <!-- inner -->wrong-->", "Dashboardwrong-->"],
    ["Dashboard<!--unterminated", "Dashboard<!--unterminated"],
    ["<!<!--comment-->--><!--tail-->", "<!-->"],
    ["<!<!--comment-->--Dashboard-->", "<!--Dashboard-->"],
    ["<span>Dashboard</span>", "<span>Dashboard</span>"],
  ])("extracts %j as literal label text %j", (markup, expected) => {
    expect(breadcrumbLabel(markup)).toBe(expected);
  });

  it.each([
    "Dashboard<!-- outer <!-- inner -->wrong-->",
    "Dashboard<!--unterminated",
    "<!<!--comment-->--><!--tail-->Dashboard",
    "Dashboard<!<!--comment-->--wrong-->",
    "<span>Dashboard</span>",
    "Events",
  ])("rejects misleading Dashboard label %j in the real breadcrumb assertion", (label) => {
    const html = `<main><nav aria-label="Breadcrumb"><a href="/admin">${label}</a><a href="/admin/events">Events</a></nav><input></main>`;
    expect(() => expectUpperBreadcrumb(html, "event")).toThrow(
      "both fixed native breadcrumb destinations and exact visible names",
    );
  });
});

// Removing, retargeting or mislabelling either upper anchor must fail, even
// when the header and bottom Cancel still offer the same destination. These
// native text links must expose their visible labels as their accessible names.
function expectUpperBreadcrumb(html: string, kind: FormFixture["kind"]) {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
  const firstField = main.search(/<(?:input|textarea|select)\b/);
  expect(firstField, "the editor has a real field").toBeGreaterThanOrEqual(0);
  const navs = [...main.slice(0, firstField).matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)].filter(
    (nav) => /\baria-label="Breadcrumb"/.test(nav[1]!),
  );
  expect(navs, "one Breadcrumb nav above the first editor field").toHaveLength(1);
  const anchors = [...navs[0]![2]!.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/g)];
  const expected = [
    { href: "/admin", label: "Dashboard" },
    kind === "event"
      ? { href: "/admin/events", label: "Events" }
      : { href: "/admin/featured", label: "Featured" },
  ];
  expect(
    anchors.map((anchor) => ({
      href: /\bhref="([^"]*)"/.exec(anchor[1]!)?.[1],
      label: breadcrumbLabel(anchor[2]!),
    })),
    "both fixed native breadcrumb destinations and exact visible names",
  ).toEqual(expected);
  for (const [index, anchor] of anchors.entries()) {
    const tag = anchor[1]!;
    expect(tag, "native, visible, keyboard-reachable text anchor").not.toMatch(
      /\s(?:onclick(?:\s|=)|role="button"|tabindex="-\d+"|hidden(?:\s|=|>)|aria-hidden="true"|aria-labelledby(?:\s|=))/,
    );
    const ariaLabel = /\baria-label="([^"]*)"/.exec(tag)?.[1];
    expect(ariaLabel ?? expected[index]!.label, "accessible name matches visible name").toBe(
      expected[index]!.label,
    );
  }
}

const names = [
  "Hono event new",
  "Kit event new",
  "Hono event edit",
  "Kit event edit",
  "Hono featured new",
  "Kit featured new",
  "Hono featured edit",
  "Kit featured edit",
];
for (const name of names) {
  it(`AO-04 ${name}: a native fixed-parent up link precedes the first editor field`, () => {
    const f = forms.find((row) => row.name === name)!;
    expectUpperBreadcrumb(f.html, f.kind);
    const parent = f.kind === "event" ? "/admin/events" : "/admin/featured";
    const upper = upperLinks(f.html).filter((link) => link.href === parent);
    expect(
      upper,
      "header and bottom Cancel links do not count as upper-page navigation",
    ).toHaveLength(1);
    expect(upper[0]!.tag).not.toMatch(/\b(?:onclick|role="button"|tabindex="-1")/);
  });
  it(`AO-05 CONTROL ${name}: Save remains a native POST to the existing action`, () => {
    const f = forms.find((row) => row.name === name)!;
    expect(f.html).toContain(`action="${f.action}"`);
    expect(f.html).toMatch(/<form\b[^>]*method="post"[^>]*data-event-editor/);
    expect(f.html).toMatch(/<button\b[^>]*type="submit"[^>]*data-testid="save-(?:event|featured)"/);
    expect(f.html).toContain("/islands/admin-event-editor.js");
  });
}

for (const name of names.filter((value) => !value.startsWith("Kit featured"))) {
  it(`AO-06 ${name}: rejected drafts retain upper navigation without changing their save action`, () => {
    const f = rejected.find((row) => row.name === name)!;
    const parent = f.kind === "event" ? "/admin/events" : "/admin/featured";
    expect(upperLinks(f.html).filter((link) => link.href === parent)).toHaveLength(1);
    expectUpperBreadcrumb(f.html, f.kind);
    expect(f.html).toContain(`action="${f.action}"`);
  });
}

it("AO-07 CONTROL: hostile editor labels stay text and cannot select another section or destination", async () => {
  const hostile = '<img src=x onerror="window.navInjected=1"> & Featured /admin';
  const honoEvent = await EventFormPage({
    mode: "edit",
    row: { ...eventRow, title: hostile },
    values: { title: hostile },
    errors: {},
  })!.toString();
  const honoFeatured = await FeaturedFormPage({
    mode: "edit",
    row: { ...featuredRow, title: hostile },
    values: { title: hostile },
    errors: {},
    appUrl: "https://example.test",
  })!.toString();
  for (const html of [
    honoEvent,
    honoFeatured,
    render("eventEdit", `/admin/events/${EVENT_KEY}`, {
      ...(cases[4]!.data as object),
      view: { ...(cases[4]!.data as { view: object }).view, title: hostile },
    }).body,
    render("featuredEdit", "/admin/featured/1", {
      view: {
        id: 1,
        title: hostile,
        status: "draft",
        visible: false,
        values: {},
        checkedAt: "2030-01-01T12:00:00Z",
      },
    }).body,
  ]) {
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(
      upperLinks(html).every((link) =>
        ["/admin", "/admin/events", "/admin/featured"].includes(link.href),
      ),
    ).toBe(true);
  }
});

for (const [path, section] of [
  ["/admin/events/not-a-key", "/admin/events"],
  ["/admin/featured/not-an-id", "/admin/featured"],
  ["/admin/featured-contents/not-an-id/edit", "/admin/featured"],
  ["/admin/join-attempts/not-an-id", "/admin/join-attempts"],
]) {
  it(`AO-08 Hono ${path}: missing family page keeps ancestor orientation`, async () => {
    const res = await pageShellFixture().request(`${path}?returnTo=https%3A%2F%2Fevil.example%2F`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expectCurrent(html, section!, false);
    expect(html).not.toContain('href="https://evil.example');
  });
}

// Render roots directly through Hono's actual ErrorPage. Missing-DB middleware
// can return plain 503 text, and the healthy legacy root redirects: neither
// executes this error resolver. The malformed legacy editor above is a real 404.
for (const [path, section, exact] of [
  ["/admin", "/admin", true],
  ["/admin/events", "/admin/events", true],
  ["/admin/featured", "/admin/featured", true],
  ["/admin/join-attempts", "/admin/join-attempts", true],
  ["/admin/activity-log", "/admin/activity-log", true],
  ["/admin/featured-contents", "/admin/featured", false],
] as const) {
  it(`AO-19 Hono ${path}: real root error render keeps exact or legacy ancestor semantics`, async () => {
    const html = await ErrorPage({ heading: "Admin temporarily unavailable", path })!.toString();
    expectCurrent(html, section, exact);
    expect(html).toContain("<h1>Admin temporarily unavailable</h1>");
    expect(html).toContain("Back to the dashboard");
  });
}

// Render the actual error components, not the successful pages with an error
// status. Root resolvers are separate branches from detail-family resolvers.
for (const [path, routeId, section, missingHeading] of [
  ["/admin", "/admin", "/admin", "Something went wrong"],
  ["/admin/events", "/admin/events", "/admin/events", "Something went wrong"],
  ["/admin/featured", "/admin/featured", "/admin/featured", "Something went wrong"],
  [
    "/admin/join-attempts",
    "/admin/join-attempts",
    "/admin/join-attempts",
    "Join attempt not found",
  ],
  ["/admin/events/missing", "/admin/events/[key]", "/admin/events", "Event not found"],
  ["/admin/featured/99", "/admin/featured/[id]", "/admin/featured", "Featured content not found"],
  [
    "/admin/join-attempts/99",
    "/admin/join-attempts/[id]",
    "/admin/join-attempts",
    "Join attempt not found",
  ],
  ["/admin/activity-log", "/admin/activity-log", "/admin/activity-log", "Something went wrong"],
]) {
  for (const status of [404, 503, 500]) {
    it(`AO-09 Kit ${status} ${path}: family chrome is truthful without echoing errors or arbitrary return URLs`, () => {
      const rendered = render(
        section === "/admin/join-attempts" ? "joinError" : "error",
        `${path}?returnTo=https%3A%2F%2Fevil.example%2F`,
        {},
        status,
        routeId,
      );
      const html = rendered.body;
      expectCurrent(html, section!, path === section);
      expect(html, "error heading remains visible").toMatch(/<h1\b[^>]*>[^<]+<\/h1>/);
      expect(/<h1\b[^>]*>([^<]+)<\/h1>/.exec(html)?.[1], "status-specific error heading").toBe(
        status === 503
          ? "Admin temporarily unavailable"
          : status === 500
            ? "Something went wrong"
            : missingHeading,
      );
      expect(rendered.head, "private error pages stay out of search").toContain("noindex");
      if (section === "/admin/join-attempts") {
        expect(html, "join boundary retains its recovery destination").toContain(
          'href="/admin/join-attempts"',
        );
        expect(html).toContain("Back to join attempts");
      }
      expect(html).not.toContain("Private diagnostic must not render");
      expect(html).not.toContain('href="https://evil.example');
      expect(html).toContain('href="/admin"');
    });
  }
}

for (const path of [
  "/administrator",
  "/admin/events-archive",
  "/admin/featured-extra",
  "/admin/featured-contents-extra",
  "/admin/join-attempts-extra",
  "/admin/activity-log-extra",
]) {
  it(`AO-18 Hono ${path}: boundary lookalikes mark no section current`, async () => {
    // Unmatched Hono requests use the public 404, not this admin resolver.
    // Exercise the real admin ErrorPage explicitly instead of a vacuous public shell.
    const html = await ErrorPage({ heading: "Not found", path })!.toString();
    expect(headerLinks(html), "real admin error chrome").toHaveLength(6);
    expect(headerLinks(html).filter((link) => link.current && link.current !== "false")).toEqual(
      [],
    );
    expect(html).toContain("Back to the dashboard");
  });
  for (const boundary of ["error", "joinError"] as const) {
    it(`AO-18 Kit ${boundary} ${path}: boundary lookalikes mark no section current`, () => {
      const html = render(boundary, path, {}, 404, path).body;
      expect(headerLinks(html), "real admin error chrome").toHaveLength(6);
      expect(headerLinks(html).filter((link) => link.current && link.current !== "false")).toEqual(
        [],
      );
      expect(html).not.toContain("Private diagnostic must not render");
    });
  }
}

it("AO-10 CONTROL: a lookalike family URL must not mark Events or Site current", () => {
  const html = render("error", "/admin/events-archive", {}, 404, "/admin/events-archive").body;
  expect(
    headerLinks(html)
      .filter((link) => link.href === "/admin/events" || link.href === "/")
      .every((link) => !link.current || link.current === "false"),
  ).toBe(true);
});

for (const row of cases.filter((item) =>
  ["eventNew", "eventEdit", "featuredNew", "featuredEdit"].includes(item.name),
)) {
  it(`AO-17 ${row.id}: an arbitrary return URL cannot replace the fixed upper parent`, async () => {
    const path = `${row.path}?returnTo=https%3A%2F%2Fevil.example%2F&next=%2F%2Fevil.example%2F`;
    const res = await pageShellFixture().request(path);
    expect(res.status).toBe(200);
    for (const html of [await res.text(), render(row.name, path, row.data).body]) {
      const links = upperLinks(html);
      expect(links.filter((link) => link.href === row.section)).toHaveLength(1);
      expect(links.every((link) => ["/admin", row.section].includes(link.href))).toBe(true);
      expectUpperBreadcrumb(html, row.section === "/admin/events" ? "event" : "featured");
    }
  });
}

it("AO-11 CONTROL: missing database status/retry behavior is unchanged", async () => {
  const fixture = pageShellFixture();
  Reflect.deleteProperty(fixture.env, "ADMIN_DB");
  for (const path of [
    "/admin/events",
    "/admin/featured",
    "/admin/join-attempts",
    "/admin/activity-log",
  ]) {
    const res = await fixture.request(path);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Admin temporarily unavailable");
    expect(res.headers.get("location")).toBeNull();
  }
  expect((await fixture.request("/admin")).status).toBe(200);
});
