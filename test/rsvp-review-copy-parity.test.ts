// The Kit pause review arrives as pre-rendered server HTML via load data —
// the shared renderRsvpPauseReviewHtml renderer Hono mirrors — injected via
// {@html}: inlined literals or a shared component would breach the client
// gzip and file-count ceilings. This pins that: no pause literal in its
// branch, no pause-only copy or disclosure markup anywhere in either page,
// every page injects its load-provided HTML, and both builders use the renderer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderRsvpPauseReviewHtml, rsvpPauseReviewCopy } from "../src/admin/rsvp-review";

const pages = {
  list: readFileSync(
    fileURLToPath(new URL("../web/src/routes/admin/events/+page.svelte", import.meta.url).href),
    "utf8",
  ),
  edit: readFileSync(
    fileURLToPath(
      new URL("../web/src/routes/admin/events/[key]/+page.svelte", import.meta.url).href,
    ),
    "utf8",
  ),
};

const builders = {
  list: readFileSync(
    fileURLToPath(new URL("../src/admin/kit-events.ts", import.meta.url).href),
    "utf8",
  ),
  edit: readFileSync(
    fileURLToPath(new URL("../src/admin/kit-event-edit.ts", import.meta.url).href),
    "utf8",
  ),
};

const pauseBoundaries = {
  list: /\{#if r\.rsvpOpen\}([\s\S]*?)\{:else\}/g,
  edit: /\{#if view\.rsvpAction === "rsvp-pause"\}([\s\S]*?)\{:else if view\.rsvpAction === "rsvp-reopen"\}/g,
};
const injections = {
  list: '{@html pauseReviews[r.eventKey] ?? ""}',
  edit: '{@html view.pauseReviewHtml ?? ""}',
};
type PageName = keyof typeof pages;

function assertServerOnlyPauseReview(name: PageName, source: string) {
  const branches = [...source.matchAll(pauseBoundaries[name])];
  expect(branches, `${name} must retain one identifiable pause boundary`).toHaveLength(1);
  const pauseSource = branches[0]![1]!;
  expect(pauseSource, `${name} pause branch must inject its load-provided HTML`).toContain(
    injections[name],
  );
  // Check longer copy first: the keep-open sentence also contains the summary.
  for (const value of Object.values(rsvpPauseReviewCopy).sort((a, b) => b.length - a.length)) {
    // "Saved event" also labels independent saved-record UI. It must still
    // never be inlined in the pause branch; pause-only copy is banned globally.
    const scope = value === rsvpPauseReviewCopy.target ? pauseSource : source;
    expect(scope, `${name} must not inline: ${value}`).not.toContain(value);
  }
  expect(source, `${name} must not inline the disclosure`).not.toContain("rsvp-pause-review");
}

describe("RSVP pause review copy parity", () => {
  it("list page injects its load-provided review HTML", () => {
    expect(pages.list).toContain("{@html pauseReviews[r.eventKey]");
  });
  it("edit page injects its load-provided review HTML", () => {
    expect(pages.edit).toContain("{@html view.pauseReviewHtml");
  });
  for (const name of ["list", "edit"] as const) {
    const source = pages[name];
    it(`inlines no pause review literal or disclosure in the ${name} page (client gzip ceiling)`, () => {
      assertServerOnlyPauseReview(name, source);
    });
    it(`allows an independent saved-event review label in the ${name} page`, () => {
      const savedReview = '<section aria-label="Saved event review">Saved event</section>';
      expect(() => assertServerOnlyPauseReview(name, savedReview + source)).not.toThrow();
    });
    for (const [key, value] of Object.entries(rsvpPauseReviewCopy)) {
      it(`rejects an inlined ${key} literal in the ${name} pause branch`, () => {
        const mutant = source.replace(injections[name], `<p>${value}</p>${injections[name]}`);
        expect(mutant).not.toBe(source);
        expect(() => assertServerOnlyPauseReview(name, mutant)).toThrow(
          `${name} must not inline: ${value}`,
        );
      });
      if (key !== "target") {
        it(`rejects pause-only ${key} copy outside the ${name} pause branch`, () => {
          expect(() => assertServerOnlyPauseReview(name, `${source}<p>${value}</p>`)).toThrow(
            `${name} must not inline: ${value}`,
          );
        });
      }
    }
    it(`rejects an inlined disclosure even alongside the ${name} HTML injection`, () => {
      const mutant = source.replace(
        injections[name],
        `<details data-testid="rsvp-pause-review"></details>${injections[name]}`,
      );
      expect(mutant).not.toBe(source);
      expect(() => assertServerOnlyPauseReview(name, mutant)).toThrow(
        `${name} must not inline the disclosure`,
      );
    });
    it(`rejects replacing the ${name} HTML injection with the real pause disclosure`, () => {
      const mutant = source.replace(
        injections[name],
        renderRsvpPauseReviewHtml("Friday games", "01J0000000000000000000ABCD"),
      );
      expect(mutant).not.toBe(source);
      expect(() => assertServerOnlyPauseReview(name, mutant)).toThrow(
        `${name} pause branch must inject its load-provided HTML`,
      );
    });
  }
  for (const [name, source] of Object.entries(builders)) {
    it(`provides pre-rendered review HTML from the ${name} builder`, () => {
      expect(source, `${name} builder must import the renderer`).toContain(
        "renderRsvpPauseReviewHtml",
      );
      expect(source, `${name} builder must import from rsvp-review`).toContain(
        'from "./rsvp-review"',
      );
    });
  }
});
