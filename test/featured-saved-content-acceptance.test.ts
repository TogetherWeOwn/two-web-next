// Saved-content contract, intentionally RED on the visibility-gated baseline.
// Run: npx vitest run test/featured-saved-content-acceptance.test.ts
// Requirements SC01-SC11: windows; SC12: draft isolation; SC13: admission;
// SC14: card semantics; SC15: no effects; CONTROL: preserved valid behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeaturedFormPage } from "../src/admin/pages/featured-form";
import { currentlyVisible } from "../src/featured-status";
import {
  APP_URL,
  CHECKED_AT,
  SAVED_BODY,
  SAVED_TITLE,
  WINDOW_CASES,
  savedFeatured,
} from "./helpers/featured-saved-content-cases";
import {
  renderSavedHono,
  renderSavedKit,
  savedValues,
} from "./helpers/featured-saved-content-render";

// Scope every negative-content assertion away from controls, which must keep the raw draft.
function inspection(html: string): string {
  const start = html.search(/<section\b[^>]*data-testid="featured-preview"/);
  if (start < 0) throw new Error("Expected the existing edit-screen preview panel");
  const end = html.indexOf("<form", start);
  if (end < 0) throw new Error("Expected the existing native editor after the preview");
  return html.slice(start, end);
}

function card(html: string): string {
  return (
    html.match(/<article\b[^>]*data-testid="featured-item"[^>]*>[\s\S]*?<\/article>/)?.[0] ?? ""
  );
}

function text(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shownInstants(html: string): number[] {
  return [...html.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)].map((match) =>
    Date.parse(match[1]!),
  );
}

afterEach(() => vi.unstubAllGlobals());

for (const [twin, render] of [
  ["Hono", renderSavedHono],
  ["Kit-executed", renderSavedKit],
] as const) {
  describe(`${twin}: saved content is independent of homepage eligibility`, () => {
    for (const fixture of WINDOW_CASES) {
      it(`${fixture.id}: inspect the saved card even when ${fixture.status}`, async () => {
        const row = savedFeatured(fixture.row);
        const panel = inspection(await render(row));
        // A saved card remains inspectable in every state, not just live.
        expect(card(panel), "Saved content must use the public card presentation").not.toBe("");
        expect(text(card(panel))).toContain(SAVED_TITLE);
        expect(text(card(panel))).toContain(SAVED_BODY);
        expect(panel).not.toContain('data-testid="featured-preview-hidden"');
        expect(panel).toMatch(/<h[2-6]\b[^>]*>\s*Saved content preview\s*<\/h[2-6]>/i);
        expect(panel).toMatch(
          /<h[2-6]\b[^>]*>\s*Homepage eligibility(?: at this check time)?\s*<\/h[2-6]>/i,
        );
        expect(panel).toContain(`data-status="${fixture.status}"`);
        const eligibility = panel.slice(panel.search(/Homepage eligibility/i));
        expect(text(eligibility)).toMatch(fixture.reason);
        expect(shownInstants(panel)).toContain(CHECKED_AT.getTime());
        expect(text(panel)).toContain("UTC");
        if (row.startsAt) {
          expect(
            shownInstants(panel),
            "Expose the SAVED start, not only the editable field",
          ).toContain(row.startsAt.getTime());
        } else {
          expect(text(panel)).toMatch(
            /(?:no (?:start|lower) (?:bound|limit)|no start time|open.{0,20}start|from.{0,20}(?:any time|unbounded)|start.{0,30}(?:not set|open|unbounded))/i,
          );
        }
        if (row.endsAt) {
          expect(
            shownInstants(panel),
            "Expose the SAVED end, not only the editable field",
          ).toContain(row.endsAt.getTime());
        } else {
          expect(text(panel)).toMatch(
            /(?:no (?:end|upper) (?:bound|limit)|no end time|open.{0,20}end|end.{0,30}(?:not set|open|unbounded)|does not expire)/i,
          );
        }
        if (fixture.status === "live") {
          expect(text(eligibility)).toMatch(
            /(?:not (?:proof|confirmation)|does not (?:prove|confirm|guarantee)|not guarantee|no guarantee|verify.{0,40}(?:guest|homepage))/i,
          );
        }
      });
    }

    it("SC14-minimal: a headline-only saved unpublished card is still meaningful", async () => {
      const panel = inspection(
        await render(
          savedFeatured({
            isPublished: false,
            body: null,
            url: null,
            imageUrl: null,
            imageAlt: null,
          }),
        ),
      );
      expect(text(card(panel))).toContain(SAVED_TITLE);
      expect(card(panel)).not.toMatch(/<a\b|<img\b/);
    });

    it("SC14-long: render full saved editorial limits as escaped content", async () => {
      const title = "🧩".repeat(255);
      const body = "<script>neverRun()</script>" + "B".repeat(973);
      const panel = inspection(await render(savedFeatured({ isPublished: false, title, body })));
      expect(card(panel)).toContain(title);
      expect(card(panel)).toMatch(/&lt;script(?:&gt;|>)neverRun\(\)&lt;\/script(?:&gt;|>)/);
      expect(card(panel)).toContain("B".repeat(973));
      expect(card(panel)).not.toContain("<script>");
    });

    for (const [index, url] of [
      "javascript:alert(1)",
      "https://name:password@example.com/secret",
      "//example.com/ambiguous",
      "https://example.com/white space",
    ].entries()) {
      it(`SC13-stored-link-${index + 1}: unpublished preview does not make a rejected link actionable`, async () => {
        const panel = inspection(await render(savedFeatured({ isPublished: false, url })));
        expect(text(card(panel))).toContain(SAVED_TITLE);
        expect(card(panel)).not.toMatch(/<a\b/);
      });
    }

    for (const [index, imageUrl] of [
      "https://unapproved.example.com/photo.webp",
      "https://name:password@cdn.discordapp.com/photo.webp",
      "//cdn.discordapp.com/photo.webp",
    ].entries()) {
      it(`SC13-blocked-image-${index + 1}: unpublished preview suppresses rejected media`, async () => {
        const panel = inspection(await render(savedFeatured({ isPublished: false, imageUrl })));
        expect(text(card(panel))).toContain(SAVED_TITLE);
        expect(card(panel)).not.toMatch(/<img\b/);
      });
    }

    it("SC13-admitted: saved unpublished link and approved image keep accessible public semantics", async () => {
      const panel = inspection(await render(savedFeatured({ isPublished: false })));
      const item = card(panel);
      expect(item).toMatch(
        /<h3\b[^>]*>[\s\S]*<a\b[^>]*href="https:\/\/example.com\/community-night"/,
      );
      expect(item).toContain('src="https://cdn.discordapp.com/attachments/1/2/board.webp"');
      expect(item).toContain('alt="A table ready for board games"');
      expect(item).toContain('referrerpolicy="no-referrer"');
    });

    it("SC15: inspecting a saved unpublished card does not fetch or mutate its row", async () => {
      let fetches = 0;
      vi.stubGlobal("fetch", () => {
        fetches++;
        throw new Error("A preview must not fetch a URL or publish content");
      });
      const row = savedFeatured({ isPublished: false });
      const before = structuredClone(row);
      const html = await render(row);
      expect(row).toEqual(before);
      expect(fetches).toBe(0);
      expect(text(card(inspection(html)))).toContain(SAVED_TITLE);
    });

    it("CONTROL-live-policy: unsafe stored media remains suppressed in a live preview", async () => {
      const panel = inspection(
        await render(
          savedFeatured({
            url: "javascript:alert(1)",
            imageUrl: "https://unapproved.example.com/no.webp",
          }),
        ),
      );
      expect(text(panel)).toContain(SAVED_TITLE);
      expect(panel).not.toMatch(/<a\b|<img\b/);
      expect(panel).toContain('data-status="live"');
    });
  });
}

describe("Hono saved-versus-submitted redisplay and unchanged eligibility authority", () => {
  for (const [id, errors] of [
    ["SC12-validation", { url: "Use a full http(s) URL without credentials." }],
    [
      "SC12-stale",
      {
        _form:
          "This slot changed since you opened it. Review the saved version before saving again.",
      },
    ],
  ] as const) {
    it(`${id}: submitted fields stay editable but never replace saved preview or window`, async () => {
      const row = savedFeatured({ isPublished: false });
      const values = {
        ...savedValues(row),
        title: "UNSAVED headline",
        body: "UNSAVED body",
        url: "https://example.com/unsaved",
        image_url: "https://cdn.discordapp.com/unsaved.webp",
        image_alt: "UNSAVED image",
        is_published: "on",
        starts_at: "2035-01-01 01:02:03",
        ends_at: "2035-01-02 01:02:03",
      };
      const html = await renderSavedHono(row, { values, errors });
      const panel = inspection(html);
      expect(text(card(panel))).toContain(SAVED_TITLE);
      expect(text(card(panel))).toContain(SAVED_BODY);
      expect(panel).not.toContain("UNSAVED");
      expect(panel).not.toContain("2035-");
      expect(panel).not.toContain("example.com/unsaved");
      expect(panel).not.toContain("cdn.discordapp.com/unsaved");
      expect(panel).toContain('data-status="unpublished"');
      expect(text(panel)).toMatch(/(?:saved|stored)/i);
      expect(text(panel)).toMatch(/(?:draft|unsaved|submitted|not saved)/i);
      expect(html).toContain('value="UNSAVED headline"');
      expect(html).toContain("UNSAVED body");
      expect(html).toContain('value="2035-01-01 01:02:03"');
      expect(html).toContain("data-event-draft");
    });
  }

  it("CONTROL-new: an unsaved create form has no saved content preview", async () => {
    const html = await FeaturedFormPage({
      mode: "new",
      values: { title: "Not saved", body: "Not a saved row" },
      errors: {},
      now: CHECKED_AT,
      appUrl: APP_URL,
    }).toString();
    expect(html).not.toContain('data-testid="featured-preview"');
    expect(html).not.toContain('data-testid="featured-item"');
    expect(html).toContain('action="/admin/featured"');
  });

  for (const fixture of WINDOW_CASES) {
    it(`CONTROL-${fixture.id}: the guest visibility verdict remains ${fixture.status === "live"}`, () => {
      expect(currentlyVisible(savedFeatured(fixture.row), CHECKED_AT)).toBe(
        fixture.status === "live",
      );
    });
  }
});
