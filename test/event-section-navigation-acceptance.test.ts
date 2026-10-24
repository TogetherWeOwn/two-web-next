// route-inventory: GET /e/:key
// Independent RED handoff. Owned with helpers/event-section-navigation.ts and
// e2e/event-section-navigation.spec.ts. Builder consumes these files unchanged.
// Run: npx vitest run test/event-section-navigation-acceptance.test.ts
// Browser: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e event-section-navigation.spec.ts --workers=1
//
// Design contract: members/moderators reading long event pages need a compact
// native "On this event" index beside the overview, before the long sections.
// Reuse the existing headings and semantic theme, not a new menu/clipboard island.
// Index only emitted substantive sections, never a lone section or hidden roster.
// Stable fragment headings + ordinary named permalinks work without JS; target
// spacing/focus/non-colour orientation and 390px wrapping are browser contracts.
// References: existing event overview/sections and native FAQ/rules interactions.
// Kit host/join/accessibility parity is independently owned: do not require absent
// Kit content here. If a twin emits those sections, every emitted one must work.
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileScheduleKit,
  renderSectionPage,
  sectionAttendees,
  sectionEvent,
  sectionOrigin,
  sectionPath,
  type KitRenderer,
} from "./helpers/event-section-navigation";

let kit: KitRenderer;
beforeAll(async () => {
  kit = await compileScheduleKit();
});

function index(html: string) {
  return html.match(/<nav\b(?=[^>]*aria-label="On this event")[^>]*>[\s\S]*?<\/nav>/i)?.[0];
}

function headings(html: string) {
  return [
    ...html.matchAll(
      /<h2\b[^>]*\bid="(event-(?:description|accessibility|join-details|share|attendees)-heading)"[^>]*>/g,
    ),
  ].map((match) => match[1]!);
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} event sections`, () => {
    for (const viewer of ["guest", "member"] as const) {
      it(`ESN-01 RED ${viewer}: native index before long content covers emitted sections exactly once`, async () => {
        const { html, status } = await renderSectionPage(twin, sectionEvent(), viewer, kit);
        expect(status, "fixture reaches the real event detail page").toBe(200);
        const nav = index(html);
        expect(nav, "missing native On this event navigation").toBeDefined();
        const hrefs = [...nav!.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1]!);
        expect(hrefs.length).toBeGreaterThan(1);
        expect(new Set(hrefs).size, "no duplicate section entries").toBe(hrefs.length);
        expect(
          hrefs.every((href) => /^#[^#\s]+$/.test(href)),
          "same-document native links",
        ).toBe(true);
        const targets = hrefs.map((href) => decodeURIComponent(href.slice(1)));
        expect(targets).toEqual(expect.arrayContaining(headings(html)));
        expect(targets).toHaveLength(headings(html).length);
        for (const target of targets) {
          const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
          expect(
            ids.filter((id) => id === target),
            `one destination for #${target}`,
          ).toHaveLength(1);
        }
        const firstSectionHeading = html.match(
          /<h2\b[^>]*\bid="event-description-heading"[^>]*>/,
        )![0];
        expect(html.indexOf(nav!)).toBeLessThan(html.indexOf(firstSectionHeading));
      });
    }

    it("ESN-02 RED: optional-section entries follow the emitted DOM, not supplied-but-unrendered fields", async () => {
      const full = await renderSectionPage(twin, sectionEvent(), "guest", kit);
      const absent = await renderSectionPage(
        twin,
        sectionEvent({ accessibilityNotes: null, join_instructions: null, join_url: null }),
        "guest",
        kit,
      );
      expect(full.status).toBe(200);
      expect(absent.status).toBe(200);
      expect(index(full.html), "long fixture has a multi-section index").toBeDefined();
      expect(index(absent.html), "About plus calendar still merits an index").toBeDefined();
      for (const id of ["event-accessibility-heading", "event-join-details-heading"]) {
        expect(index(full.html)!.includes(`href="#${id}"`)).toBe(full.html.includes(`id="${id}"`));
        expect(index(absent.html)).not.toContain(`href="#${id}"`);
      }
    });

    it("ESN-03 CONTROL: a minimal guest page does not grow a redundant single-entry index", async () => {
      const result = await renderSectionPage(
        twin,
        sectionEvent({
          description: null,
          accessibilityNotes: null,
          join_url: null,
          join_instructions: null,
        }),
        "guest",
        kit,
      );
      expect(result.status).toBe(200);
      expect(result.html).toContain('data-testid="event-ics"');
      expect(result.html).not.toContain('id="event-description-heading"');
      expect(index(result.html)).toBeUndefined();
    });

    for (const viewer of ["guest", "outsider", "member"] as const) {
      it(`ESN-04 CONTROL ${viewer}: no new reads or private roster disclosure to populate the index`, async () => {
        const result = await renderSectionPage(twin, sectionEvent(), viewer, kit);
        expect(result.status).toBe(200);
        expect(result.headers["cache-control"]).toBe("private, no-store");
        expect(result.headers.vary).toContain("Cookie");
        expect(result.rosterReads).toBe(viewer === "member" ? 1 : 0);
        // Baseline read counts at the execution base. Any index-only new read
        // must fail even when its result never leaks into rendered HTML.
        const expectedReads =
          twin === "Hono"
            ? viewer === "member"
              ? 9
              : viewer === "outsider"
                ? 7
                : 6
            : viewer === "member"
              ? 7
              : viewer === "outsider"
                ? 5
                : 4;
        expect(result.reads).toHaveLength(expectedReads);
        for (const attendee of sectionAttendees) {
          if (viewer === "member") {
            expect(result.html).toContain(attendee.name);
            expect(result.html).toContain(`/members/${attendee.id}`);
          } else {
            expect(result.html).not.toContain(attendee.id);
            expect(result.html).not.toContain(attendee.name);
            expect(result.html).not.toContain('id="event-attendees-heading"');
            expect(index(result.html) ?? "").not.toContain("attendee");
          }
        }
      });
    }

    it("ESN-05 CONTROL: canonical, whole-event copy and calendar URLs remain fragment-free", async () => {
      const { html, status } = await renderSectionPage(twin, sectionEvent(), "guest", kit);
      expect(status).toBe(200);
      const canonical = `${sectionOrigin}${sectionPath}`;
      expect(html).toMatch(new RegExp(`<link[^>]*rel="canonical"[^>]*href="${canonical}"`));
      expect(html).toContain(`data-copy-link="${canonical}"`);
      expect(html).toMatch(
        new RegExp(`<a[^>]*href="${canonical}"[^>]*data-copy-link="${canonical}"`),
      );
      expect(html).toContain(`href="/events/${sectionPath.slice(3)}.ics"`);
      expect(html).not.toMatch(/data-copy-link="[^"\s]*#/);
    });

    for (const status of ["draft", "past", "cancelled"] as const) {
      it(`ESN-06 CONTROL ${status}: existing status/access behavior survives section navigation`, async () => {
        const row = sectionEvent({ status });
        const guest = await renderSectionPage(twin, row, "guest", kit);
        if (status === "draft") {
          expect(guest.status).toBe(403);
          expect(index(guest.html)).toBeUndefined();
          const mod = await renderSectionPage(twin, row, "moderator", kit);
          expect(mod.status).toBe(200);
          expect(mod.html).toContain('data-testid="event-draft"');
          expect(mod.html).not.toContain('data-testid="event-public-join-link"');
        } else if (status === "cancelled") {
          expect(guest.status).toBe(410);
          expect(guest.rosterReads).toBe(0);
          expect(guest.html).not.toContain('data-testid="event-public-join-link"');
          expect(guest.html).not.toContain(sectionAttendees[0]!.name);
        } else {
          expect(guest.status).toBe(200);
          expect(guest.html).toContain('data-testid="event-past"');
          expect(guest.html).not.toContain('id="event-join-details-heading"');
          expect(index(guest.html) ?? "").not.toContain('href="#event-join-details-heading"');
        }
      });
    }
  });
}
