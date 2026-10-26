// route-inventory: GET /e/:key
// Acceptance-owned: missing cues/help fail on base; negative/admission/privacy
// controls must already pass. Builder incorporates these files unchanged.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { DiscordTransient } from "../src/islands/contracts";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cardHtml } from "./calendar-card-scan.fixtures";
import { renderCalendar } from "./helpers/calendar-multiday-acceptance";
import {
  CUE,
  DETAIL_PATH,
  EVENT_KEY,
  HELP,
  HOSTILE_NOTES,
  NOTES,
  ORIGIN,
  detailStates,
  renderDetail,
  scanEvent,
} from "./helpers/participation-guidance";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
function elements(node: Node): Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}
function text(node: Node): string {
  return "value" in node
    ? node.value
    : "childNodes" in node
      ? node.childNodes.map(text).join("")
      : "";
}
const links = (html: string, label: string) =>
  elements(parse(html)).filter((node) => node.tagName === "a" && text(node).trim() === label);
function card(html: string) {
  const found = elements(parse(html)).find(
    (node) => node.tagName === "article" && attr(node, "data-event-key") === EVENT_KEY,
  );
  expect(found, "fixture reaches the canonical schedule card").toBeDefined();
  return found!;
}
function hasAncestor(node: Node, predicate: (element: Element) => boolean): boolean {
  let parent = "parentNode" in node ? node.parentNode : null;
  while (parent) {
    if ("tagName" in parent && predicate(parent)) return true;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return false;
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} participation guidance`, () => {
    it.each(["Quiet room available on request.", ` \n ${HOSTILE_NOTES}\t `])(
      "links nonblank organizer notes to the existing heading, without copying notes: %j",
      async (notes) => {
        const html = await renderCalendar(twin, [scanEvent({ accessibilityNotes: notes })], {
          view: "list",
          month: "2030-06",
        });
        const cue = elements(card(html)).filter(
          (node) => node.tagName === "a" && text(node).trim() === CUE,
        );
        expect(cue, "missing planning-information destination on canonical card").toHaveLength(1);
        expect(attr(cue[0]!, "href")).toBe(`${DETAIL_PATH}#event-accessibility-heading`);
        expect(hasAncestor(cue[0]!, (n) => n.tagName === "details")).toBe(false);
        expect(html).not.toContain(notes.trim());
        expect(html).not.toContain("Planning-only marker");
        expect(html).not.toContain("onerror=");
        const detail = await renderDetail(twin, detailStates[0]!, notes);
        const heading = elements(parse(detail.html)).filter(
          (n) => attr(n, "id") === "event-accessibility-heading",
        );
        expect(heading).toHaveLength(1);
        expect(heading[0]!.tagName).toBe("h2");
        expect(text(heading[0]!)).toBe("Accessibility");
      },
    );

    it.each([null, "", " \t\n\r ", "  "])(
      "CONTROL: no positive accessibility cue for absent/blank notes: %j",
      async (accessibilityNotes) => {
        const html = await renderCalendar(twin, [scanEvent({ accessibilityNotes })], {
          view: "list",
          month: "2030-06",
        });
        expect(text(card(html))).toContain("Community overnight games");
        expect(links(html, CUE)).toHaveLength(0);
      },
    );

    it.each(["draft", "cancelled"])(
      "CONTROL: no positive cue for %s rows even with notes",
      async (status) => {
        const html = await renderCalendar(
          twin,
          [scanEvent({ status, accessibilityNotes: NOTES })],
          { view: "list", month: "2030-06" },
        );
        expect(links(html, CUE)).toHaveLength(0);
        expect(html).not.toContain("Planning-only marker");
      },
    );

    it("CONTROL: Discord-only rows cannot gain an accessibility promise from an extra field", async () => {
      const transient: DiscordTransient & { accessibilityNotes: string } = {
        discordId: "123456789012345678",
        status: "scheduled",
        title: "Discord-only gathering",
        description: "Synthetic voice gathering",
        location: "Voice",
        startsAt: new Date("2030-06-02T06:30:00Z"),
        endsAt: null,
        accessibilityNotes: NOTES,
      };
      const html = await renderCalendar(twin, [transient], { view: "list", month: "2030-06" });
      expect(html).toContain("Discord-only gathering");
      expect(html).toContain("RSVP in Discord");
      expect(links(html, CUE)).toHaveLength(0);
      expect(html).not.toContain("Planning-only marker");
    });

    for (const state of detailStates) {
      it(`${state.name}: existing reservation controls survive and contextual help is a native FAQ link`, async () => {
        const { html } = await renderDetail(twin, state);
        const nodes = elements(parse(html));
        for (const id of state.present)
          expect(
            nodes.some((n) => attr(n, "data-testid") === id),
            id,
          ).toBe(true);
        for (const id of state.absent)
          expect(
            nodes.some((n) => attr(n, "data-testid") === id),
            id,
          ).toBe(false);
        if (!state.member) expect(text(parse(html))).toContain("Log in with Discord");
        const help = links(html, HELP);
        expect(help, "reservation decision needs its existing FAQ explanation").toHaveLength(1);
        expect(attr(help[0]!, "href")).toBe("/faq#faq-events");
        expect(attr(help[0]!, "role")).not.toBe("button");
        expect(attr(help[0]!, "onclick")).toBeUndefined();
        expect(attr(help[0]!, "formaction")).toBeUndefined();
        expect(attr(help[0]!, "target") ?? "_self").toBe("_self");
        expect(hasAncestor(help[0]!, (n) => n.tagName === "details")).toBe(false);
        expect(text(parse(html))).not.toMatch(
          /waitlist(?:ing|ed)? reserves a seat|Going proves attendance|syncing means.*failed/i,
        );
      });
    }

    it("CONTROL: actual notes stay escaped in their existing section", async () => {
      const { html } = await renderDetail(twin, detailStates[0]!, HOSTILE_NOTES);
      const nodes = elements(parse(html));
      const section = nodes.find((n) => attr(n, "data-testid") === "event-accessibility");
      expect(section).toBeDefined();
      expect(text(section!)).toContain(HOSTILE_NOTES);
      expect(elements(section!).some((n) => n.tagName === "img" || n.tagName === "script")).toBe(
        false,
      );
      const payloads = nodes.flatMap((n) =>
        n.attrs.filter((a) => a.name.startsWith("data-")).map((a) => a.value),
      );
      expect(payloads.join("\n")).not.toContain("Planning-only marker");
    });
  });
}

it.each([false, true])(
  "schedule cue preserves guest/member participation controls (member=%s)",
  (member) => {
    const html = cardHtml(scanEvent({ accessibilityNotes: NOTES }), member);
    expect(html).toContain('data-testid="event-going-count"');
    expect(html).toContain("3 of 8 going");
    expect(html.includes('data-testid="signin"')).toBe(!member);
    expect(links(html, CUE)).toHaveLength(1);
  },
);

it("CONTROL: the native help destination resolves to the shipped FAQ Events section", async () => {
  const response = await app.request("/faq", {}, { APP_URL: ORIGIN } as Env);
  expect(response.status).toBe(200);
  const section = elements(parse(await response.text())).find(
    (n) => attr(n, "aria-labelledby") === "faq-events",
  );
  expect(section).toBeDefined();
  expect(text(section!)).toMatch(/first.in.first.out|FIFO/i);
  expect(text(section!)).toMatch(/waitlist/i);
});

it("CONTROL: Kit reuses its existing event read and does not disclose member reads to guests", async () => {
  const guest = await renderDetail("Kit", detailStates[0]!);
  expect([...guest.calls].sort()).toEqual(["db", "event", "neighbors", "related", "series"]);
  const member = await renderDetail("Kit", detailStates[1]!);
  expect([...member.calls].sort()).toEqual([
    "answer",
    "attendees",
    "db",
    "event",
    "neighbors",
    "related",
    "series",
    "waitlist",
  ]);
  expect(guest.calls).not.toContain("attendees");
  expect(guest.calls).not.toContain("answer");
  expect(guest.headers["Cache-Control"] ?? guest.headers["cache-control"]).toBe(
    "private, no-store",
  );
  const blank = await renderDetail("Kit", detailStates[0]!, null);
  expect(guest.calls).toEqual(blank.calls);
});

it("CONTROL: Hono detail notes need no extra query, writes or changed cache admission", async () => {
  async function request(accessibilityNotes: string | null) {
    const event = scanEvent({ accessibilityNotes });
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    const statements: string[] = [];
    const db = drizzle(async (sql, params) => {
      statements.push(sql);
      if (sql.includes('from "rsvps"'))
        return { rows: sql.includes("count(*)") ? [[event.id, 3]] : [] };
      if (
        sql.includes('"event_key" =') &&
        !sql.includes('"status" =') &&
        params.includes(EVENT_KEY)
      )
        return {
          rows: [
            columns.map((key) => {
              const value = event[key];
              return value instanceof Date ? value.toISOString() : value;
            }),
          ],
        };
      return { rows: [] };
    });
    const response = await app.request(DETAIL_PATH, {}, {
      APP_URL: ORIGIN,
      ADMIN_DB: db as unknown as Db,
      SESSION_STORE: createMemorySessionStore(),
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    } as unknown as Env);
    return { response, html: await response.text(), statements };
  }
  const blank = await request(null);
  const noted = await request(NOTES);
  expect(noted.response.status).toBe(200);
  expect(noted.html).toContain('id="event-accessibility-heading"');
  expect(noted.response.headers.get("cache-control")).toBe("private, no-store");
  expect(noted.statements).toEqual(blank.statements);
  expect(noted.statements.every((sql) => /^select\b/i.test(sql))).toBe(true);
  expect(
    noted.statements.filter((sql) => sql.includes('"event_key" =') && !sql.includes('"status" =')),
  ).toHaveLength(1);
  expect(
    noted.statements.filter((sql) => /select\s+"accessibility_notes"\s+from/i.test(sql)),
  ).toHaveLength(0);
});
