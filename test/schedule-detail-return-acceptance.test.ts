// route-inventory: GET /events
// route-inventory: GET /e/:key
// Test-author-owned. Consume unchanged; corrections belong in a bounded handback.
// Breaks caught: lost browse state, raw-state echo, continuation loss, ambiguous
// parser admission, metadata/OAuth leakage, or context changing classified reads.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "parse5";
import * as access from "../src/admin/store-access";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { attendeeId } from "./helpers/archive-detail-return-acceptance";
import { eventKeys, linksIn, type ArchiveTwin } from "./helpers/past-archive-search-acceptance";
import {
  GRID_PATH,
  LIST_PATH,
  PAST_KEY,
  SCHEDULE_NOW,
  SCHEDULE_ORIGIN,
  SCHEDULE_QUERY,
  SCHEDULE_TWINS,
  SELECTED_KEY,
  SELECTED_PATH,
  compileReturnTwins,
  scheduleDetailFixture,
  scheduleFixture,
  scheduleRow,
} from "./helpers/schedule-detail-return-acceptance";

let twins: Awaited<ReturnType<typeof compileReturnTwins>>;
let calendar: ReturnType<typeof scheduleFixture>;
let source: ReturnType<typeof scheduleDetailFixture>;
let audits: string[][];
beforeAll(async () => {
  twins = await compileReturnTwins();
});
afterAll(() => twins?.dispose());
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SCHEDULE_NOW);
  calendar = scheduleFixture();
  source = scheduleDetailFixture();
  audits = [];
  vi.spyOn(access, "recordAccess").mockImplementation(async (_db, entry) => {
    audits.push(entry.subjectUserIds);
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const relative = (u: URL) => u.pathname + u.search + u.hash;
// Body text as rendered, so search highlighting (<mark>) cannot split a title.
function visibleText(html: string): string {
  type Node = { nodeName: string; value?: string; childNodes?: Node[] };
  const hidden = new Set(["head", "script", "style", "template"]);
  const walk = (node: Node): string =>
    node.nodeName === "#text"
      ? (node.value ?? "")
      : hidden.has(node.nodeName)
        ? ""
        : (node.childNodes ?? []).map(walk).join("");
  return walk(parse(html) as unknown as Node);
}
async function detail(
  twin: ArchiveTwin,
  url: URL,
  viewer: "guest" | "member" | "outsider" = "guest",
) {
  return twins.detail(twin, url, source, viewer, async (entry) => {
    audits.push(entry.subjectUserIds);
    return true;
  });
}
async function entry(twin: ArchiveTwin, path = LIST_PATH, key = SELECTED_KEY, island = false) {
  const response = await calendar.render(twin, path, island);
  expect(response.status).toBe(200);
  const html = await response.text();
  const link = linksIn(html).find((l) => l.url.pathname === `/e/${key}`);
  expect(link, "fixture must expose a native live-event detail entry").toBeDefined();
  return { html, url: link!.url };
}
function returnLink(html: string, want: Record<string, string>, key = SELECTED_KEY) {
  const link = linksIn(html).find(
    (l) => l.url.pathname === "/events" && l.url.hash === `#event-${key}`,
  );
  expect(link, "detail must return to these results and the selected event anchor").toBeDefined();
  expect(link!.url.origin).toBe(SCHEDULE_ORIGIN);
  expect(Object.fromEntries(link!.url.searchParams)).toEqual(want);
  expect(link!.label).toMatch(/back|return|results|schedule|calendar/i);
  expect(link!.label).not.toMatch(/^\s*[←→]?\s*$/);
  return link!.url;
}
const listState = { q: SCHEDULE_QUERY, game: "Chess", past: "1", page: "2" };
function fallback(html: string) {
  const link = linksIn(html).find((l) => /all events/i.test(l.label));
  expect(link, "direct or rejected context must retain All events").toBeDefined();
  expect(link!.url.href).toBe(`${SCHEDULE_ORIGIN}/events`);
  expect(linksIn(html).some((l) => l.url.hostname === "evil.example")).toBe(false);
}
function fields(url: URL) {
  const entries = [...url.searchParams];
  const q = entries.find(([, value]) => value === SCHEDULE_QUERY)?.[0];
  const page = entries.find(([, value]) => value === "2")?.[0];
  const game = entries.find(([, value]) => value === "Chess")?.[0];
  expect(q, "entry carries a bounded structured query, not an arbitrary return URL").toBeDefined();
  expect(page, "entry carries the normalized effective list page").toBeDefined();
  expect(game, "entry carries the admitted game facet").toBeDefined();
  return { q: q!, page: page!, game: game! };
}
function destinationSurface(html: string) {
  type Node = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
  const nodes: { tag: string; attrs: Record<string, string> }[] = [];
  function walk(node: Node) {
    if (node.tagName)
      nodes.push({
        tag: node.tagName,
        attrs: Object.fromEntries((node.attrs ?? []).map((a) => [a.name, a.value])),
      });
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(parse(html) as Node);
  const testid = (id: string) => nodes.find((n) => n.attrs["data-testid"] === id)?.attrs;
  return {
    canonical: nodes.find((n) => n.attrs.rel === "canonical")?.attrs.href,
    markdown: nodes.find((n) => n.attrs.type === "text/markdown")?.attrs.href,
    social: nodes.find((n) => n.attrs.property === "og:url")?.attrs.content,
    copy: testid("event-copy-link")?.["data-copy-link"],
    share: testid("event-share")?.["data-share-url"],
    ics: testid("event-ics")?.href,
    google: testid("event-google-calendar")?.href,
    jsonLd: html.match(/<script[^>]*data-testid="event-jsonld"[^>]*>([\s\S]*?)<\/script>/)?.[1],
    // Presentation context must not retarget OAuth or alter the mutation action.
    auth: linksIn(html)
      .filter((l) => /^\/(auth\/discord|join)(\/|$)/.test(l.url.pathname))
      .map((l) => relative(l.url)),
    forms: nodes.filter((n) => n.tag === "form").map((n) => n.attrs.action),
    islands: nodes.filter((n) => n.tag === "script" && n.attrs.src).map((n) => n.attrs.src),
  };
}

describe.each(SCHEDULE_TWINS)("%s upcoming schedule return", (twin) => {
  it("CONTROL: real fixture filters before page two and separates past, cancelled and transient rows", async () => {
    const { html } = await entry(twin);
    expect(eventKeys(html)).toEqual([21, 22, 23, 24, 25, 41].map((id) => scheduleRow(id).eventKey));
    expect(html).not.toContain("Unrelated chess clinic");
    expect(html).not.toContain("Discord-only chess night");
    // Measured on unchanged source: nine list reads, twelve grid reads. Browse
    // context must be pure presentation, not a new database lookup.
    expect(calendar.queries).toHaveLength(9);
    const grid = await calendar.render(twin, GRID_PATH);
    expect(grid.status).toBe(200);
    expect(await grid.text()).toContain('data-testid="events-calendar-grid"');
    expect(calendar.queries).toHaveLength(21);
  });

  it.each([false, true])(
    "native/fragment entries preserve q + game + page-two results (fragment=%s)",
    async (island) => {
      const { url } = await entry(twin, LIST_PATH, SELECTED_KEY, island);
      const names = fields(url);
      expect(new Set(Object.values(names)).size).toBe(3);
      expect(url.search.length).toBeLessThanOrEqual(4096);
      expect(url.hash).toBe("");
      const html = await (await detail(twin, url)).text();
      const back = returnLink(html, listState);
      expect(eventKeys(await (await calendar.render(twin, relative(back))).text())).toEqual(
        [21, 22, 23, 24, 25, 41].map((id) => scheduleRow(id).eventKey),
      );
    },
  );

  it("an unfiltered first-page entry still returns to its selected anchor", async () => {
    const key = scheduleRow(1).eventKey;
    const { url } = await entry(twin, "/events", key);
    source.setEvent(scheduleRow(1));
    returnLink(await (await detail(twin, url)).text(), {}, key);
  });

  it.each(["🌌".repeat(255), "https://evil.example/path?q=x", 'a%_\\ "quoted" query'])(
    "admitted structured search text is data, not a return URL (%#)",
    async (query) => {
      const { url } = await entry(twin);
      const names = fields(url);
      url.searchParams.set(names.q, query);
      returnLink(await (await detail(twin, url)).text(), { ...listState, q: query });
    },
  );

  it("fresh GET/new-tab/reload and cross-twin visits agree without Referer or storage", async () => {
    const { url } = await entry(twin === "Hono" ? "Kit" : "Hono");
    for (let visit = 0; visit < 3; visit++) {
      const response = await detail(twin, new URL(url.href));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      returnLink(await response.text(), listState);
    }
  });

  it("uses effective list view and ignores irrelevant raw month, view and unknown keys", async () => {
    const path =
      LIST_PATH +
      "&view=calendar&month=garbage&returnTo=https%3A%2F%2Fevil.example&unrelated=secret-draft";
    const { url } = await entry(twin, path);
    expect(url.search).not.toContain("garbage");
    expect(url.search).not.toContain("secret-draft");
    expect(url.search).not.toContain("evil.example");
    returnLink(await (await detail(twin, url)).text(), listState);
  });

  it.each([" cHeSs ", "not-an-offered-game"])(
    "uses the admitted game rather than raw %s",
    async (game) => {
      const path = `/events?${new URLSearchParams({ q: SCHEDULE_QUERY, game, page: "2" })}`;
      const { url } = await entry(twin, path);
      expect(url.search).not.toContain(encodeURIComponent(game));
      returnLink(await (await detail(twin, url)).text(), {
        q: SCHEDULE_QUERY,
        page: "2",
        ...(game.trim() === "cHeSs" ? { game: "Chess" } : {}),
      });
    },
  );

  it("keeps the past drawer origin rather than mislabelling it as archive context", async () => {
    const { url } = await entry(twin, LIST_PATH, PAST_KEY);
    source.setEvent(
      scheduleRow(41, {
        status: "past",
        startsAt: new Date("2029-01-10T20:00:00Z"),
        endsAt: new Date("2029-01-10T22:00:00Z"),
      }),
    );
    const html = await (await detail(twin, url)).text();
    returnLink(html, listState, PAST_KEY);
    expect(linksIn(html).some((l) => l.url.pathname === "/events/past")).toBe(false);
  });

  it("retains the month-grid origin through an applicable direct entry or its native card jump", async () => {
    const gridHtml = await (await calendar.render(twin, GRID_PATH + "&page=99")).text();
    const link = linksIn(gridHtml).find(
      (l) => l.url.pathname === SELECTED_PATH || l.url.hash === `#event-${SELECTED_KEY}`,
    );
    expect(link, "month fixture exposes the selected entry").toBeDefined();
    let url = link!.url;
    if (url.pathname === "/events") url = (await entry(twin, relative(url))).url;
    const back = returnLink(await (await detail(twin, url)).text(), {
      game: "Chess",
      past: "1",
      view: "calendar",
      month: "2031-01",
    });
    const returned = await (await calendar.render(twin, relative(back))).text();
    expect(returned).toContain('data-testid="events-calendar-grid"');
    expect(returned).toContain(`id="event-${SELECTED_KEY}"`);
  });

  it.each([
    ["month", "2031-99", false],
    ["view", "not-a-view", false],
    ["month", "2031-01", true],
    ["view", "calendar", true],
  ] as const)(
    "rejects malformed or duplicate grid %s=%s (duplicate=%s)",
    async (field, value, duplicate) => {
      const grid = await (await calendar.render(twin, GRID_PATH)).text();
      const link = linksIn(grid).find(
        (l) => l.url.pathname === SELECTED_PATH || l.url.hash === `#event-${SELECTED_KEY}`,
      );
      expect(link).toBeDefined();
      const url =
        link!.url.pathname === "/events" ? (await entry(twin, relative(link!.url))).url : link!.url;
      const name = [...url.searchParams].find(
        ([, v]) => v === (field === "month" ? "2031-01" : "calendar"),
      )?.[0];
      expect(name, "grid entry must carry its effective month and view").toBeDefined();
      returnLink(await (await detail(twin, url)).text(), {
        game: "Chess",
        past: "1",
        view: "calendar",
        month: "2031-01",
      });
      if (duplicate) url.searchParams.append(name!, value);
      else url.searchParams.set(name!, value);
      fallback(await (await detail(twin, url)).text());
    },
  );

  it("keeps context on attendee next, previous, empty-page recovery and native refresh", async () => {
    let current = (await entry(twin)).url;
    for (const page of [1, 2, 3]) {
      const html = await (await detail(twin, current, "member")).text();
      expect(html).toContain(`>return-attendee-${(page - 1) * 100}</a>`);
      expect(html).not.toContain(`>return-attendee-${page * 100}</a>`);
      expect(audits.at(-1)).toEqual(
        Array.from({ length: Math.min(101, 205 - (page - 1) * 100) }, (_, i) =>
          attendeeId((page - 1) * 100 + i),
        ),
      );
      returnLink(html, listState);
      const refresh = linksIn(html).find((l) => /Refresh attendees/.test(l.label));
      expect(refresh).toBeDefined();
      returnLink(await (await detail(twin, refresh!.url, "member")).text(), listState);
      const next = linksIn(html).find(
        (l) => l.url.searchParams.get("attendees") === String(page + 1),
      );
      if (page < 3) {
        expect(next).toBeDefined();
        current = next!.url;
      } else {
        const previous = linksIn(html).find((l) => l.url.searchParams.get("attendees") === "2");
        expect(previous).toBeDefined();
        returnLink(await (await detail(twin, previous!.url, "member")).text(), listState);
      }
    }
    current.searchParams.set("attendees", "99");
    const empty = await (await detail(twin, current, "member")).text();
    const recovery = linksIn(empty).find((l) => /Previous attendees/.test(l.label));
    expect(recovery).toBeDefined();
    expect(recovery!.url.searchParams.get("attendees") ?? "1").toBe("1");
    returnLink(await (await detail(twin, recovery!.url, "member")).text(), listState);
  });

  it("keeps canonical, share, Markdown, exports, OAuth and RSVP destinations identical to a direct visit", async () => {
    const baseline = await (await detail(twin, new URL(SELECTED_PATH, SCHEDULE_ORIGIN))).text();
    const contextual = await (await detail(twin, (await entry(twin)).url)).text();
    const clean = destinationSurface(baseline);
    expect(clean.canonical).toContain(`${SCHEDULE_ORIGIN}${SELECTED_PATH}`);
    expect(clean.markdown).toContain(`${SELECTED_PATH}.md`);
    expect(clean.copy).toContain(`${SCHEDULE_ORIGIN}${SELECTED_PATH}`);
    expect(clean.share).toContain(`${SCHEDULE_ORIGIN}${SELECTED_PATH}`);
    expect(clean.ics).toContain(`/events/${SELECTED_KEY}.ics`);
    expect(clean.google).toContain("TEMPLATE");
    expect(JSON.parse(clean.jsonLd!).url).toBe(`${SCHEDULE_ORIGIN}${SELECTED_PATH}`);
    expect(destinationSurface(contextual)).toEqual(clean);
    returnLink(contextual, listState);
  });

  it.each(["guest", "outsider", "member"] as const)(
    "context adds no reads or attendee authority for %s",
    async (viewer) => {
      const { url } = await entry(twin);
      await detail(twin, new URL(SELECTED_PATH, SCHEDULE_ORIGIN), viewer);
      const baseline = source.statements.splice(0);
      expect(baseline).toHaveLength({ guest: 6, outsider: 7, member: 10 }[viewer]);
      const expectedAudit = audits.splice(0);
      const html = await (await detail(twin, url, viewer)).text();
      expect(source.statements).toEqual(baseline);
      expect(audits).toEqual(expectedAudit);
      if (viewer !== "member") {
        expect(html).not.toContain("return-attendee-");
        expect(audits).toEqual([]);
      }
      returnLink(html, listState);
    },
  );

  it("CONTROL: a failed audit refuses identity bytes despite browse input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(access.recordAccess).mockResolvedValue(false);
    const url = (await entry(twin)).url;
    const response = await twins.detail(twin, url, source, "member", async () => false);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("return-attendee-");
  });

  it.each(["draft", "cancelled", "missing"] as const)(
    "CONTROL: context does not change %s visibility",
    async (status) => {
      const { url } = await entry(twin);
      source.setEvent(status === "missing" ? null : { ...scheduleRow(21), status });
      const response = await detail(twin, url);
      expect(response.status).toBe(status === "draft" ? 403 : status === "cancelled" ? 410 : 404);
      expect(await response.text()).not.toContain("return-attendee-");
    },
  );

  it("CONTROL: cancelled titles and Discord transients never acquire a detail link", async () => {
    const html = await (await calendar.render(twin, "/events?q=Cancelled")).text();
    expect(visibleText(html)).toContain("Cancelled chess night");
    expect(linksIn(html).some((l) => l.url.pathname === `/e/${scheduleRow(33).eventKey}`)).toBe(
      false,
    );
    const first = await (await calendar.render(twin, "/events")).text();
    expect(first).toContain("Discord-only chess night");
    expect(linksIn(first).some((l) => l.url.pathname.includes("/e/discord-"))).toBe(false);
  });

  it("archive context wins when both valid origins are supplied", async () => {
    const archive = await twins.archive(twin, "/events/past?page=2&q=Raid", source);
    const archiveLink = linksIn(await archive.text()).find((l) => l.url.pathname.startsWith("/e/"));
    expect(archiveLink).toBeDefined();
    const url = (await entry(twin)).url;
    for (const [key, value] of archiveLink!.url.searchParams) url.searchParams.append(key, value);
    const html = await (await detail(twin, url)).text();
    const back = linksIn(html).find((l) => l.url.pathname === "/events/past");
    expect(back).toBeDefined();
    expect(Object.fromEntries(back!.url.searchParams)).toEqual({ page: "2", q: "Raid" });
    expect(
      linksIn(html).some(
        (l) => l.url.pathname === "/events" && l.url.hash === `#event-${SELECTED_KEY}`,
      ),
    ).toBe(false);
  });

  it("CONTROL: direct visits and arbitrary return URLs keep All events", async () => {
    for (const value of [null, "https://evil.example/", "//evil.example/", "/profile"]) {
      const url = new URL(SELECTED_PATH, SCHEDULE_ORIGIN);
      if (value)
        url.search = new URLSearchParams({
          next: value,
          return: value,
          returnTo: value,
        }).toString();
      const response = await detail(twin, url);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      fallback(await response.text());
    }
  });

  it.each(["0", "-1", "2suffix", "9007199254740992", "https://evil.example/", "//evil.example/"])(
    "rejects malformed/external structured page %s after a valid positive control",
    async (bad) => {
      const { url } = await entry(twin);
      const names = fields(url);
      returnLink(await (await detail(twin, url)).text(), listState);
      url.searchParams.set(names.page, bad);
      fallback(await (await detail(twin, url)).text());
    },
  );

  it.each(["q", "page", "game"] as const)(
    "rejects duplicated %s instead of first-value-wins",
    async (field) => {
      const { url } = await entry(twin);
      const names = fields(url);
      returnLink(await (await detail(twin, url)).text(), listState);
      url.searchParams.append(names[field], url.searchParams.get(names[field])!);
      fallback(await (await detail(twin, url)).text());
    },
  );

  it.each(["🌌".repeat(256), " ".repeat(256), "x".repeat(8192)])(
    "rejects oversized structured query before normalizing it (%#)",
    async (bad) => {
      const { url } = await entry(twin);
      const names = fields(url);
      returnLink(await (await detail(twin, url)).text(), listState);
      url.searchParams.set(names.q, bad);
      fallback(await (await detail(twin, url)).text());
    },
  );

  it("rejects malformed encoded Unicode rather than silently replacing it", async () => {
    const { url } = await entry(twin);
    const names = fields(url);
    returnLink(await (await detail(twin, url)).text(), listState);
    url.searchParams.delete(names.q);
    url.search += `&${encodeURIComponent(names.q)}=%E0%A4%A`;
    fallback(await (await detail(twin, url)).text());
  });
});
