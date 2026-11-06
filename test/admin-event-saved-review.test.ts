import { describe, expect, it } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";
import { renderSavedEventReviewHtml } from "../src/admin/pages/event-form-review";

const now = new Date("2030-01-10T20:00:00Z");
const row = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  status: "draft",
  location: "Voice room",
  startsAt: new Date("2030-01-10T19:00:00Z"),
  endsAt: new Date("2030-01-10T21:00:00Z"),
  updatedAt: new Date("2030-01-09T11:12:13Z"),
};

describe("saved-event review read model", () => {
  it("does not invent provenance when an older projection omits the update time", () => {
    expect(savedEventReview({ ...row, updatedAt: undefined }, now).updatedAt).toBeNull();
  });

  it("uses the persisted update time, not the rendering clock", () => {
    expect(savedEventReview(row, now).updatedAt).toBe(row.updatedAt.toISOString());
  });

  it("retains both corrections and links to the persisted member detail rendering", () => {
    const view = savedEventReview({ ...row, location: " \t ", endsAt: new Date(0) }, now);
    expect(view.corrections.map((issue) => issue.href)).toEqual([
      `${view.editHref}#f-location`,
      `${view.editHref}#f-ends-at`,
    ]);
    expect(view.href).toBe(`/e/${row.eventKey}?review=1`);
    expect(view.corrections[0]?.message).toBe("Location is blank. Add a location and save.");
  });

  it("describes cancellation instead of offering publication advice", () => {
    const view = savedEventReview({ ...row, status: "cancelled" }, now);
    // Cancelled events still appear in listings, so the guidance makes no
    // listing claim; status guidance stays.
    expect(view.guidance).toBe("This event is cancelled.");
    expect(view.guidance).not.toContain("listings");
    expect(view.guidance).not.toContain("Members don't see it");
    expect(view.corrections).toEqual([]);
    // Cancellation guidance is independent of the draft-only corrections.
    const broken = savedEventReview(
      { ...row, status: "cancelled", location: null, endsAt: new Date(0) },
      now,
    );
    expect(broken.guidance).toBe("This event is cancelled.");
    expect(broken.corrections).toEqual([]);
  });

  it("describes the published record rather than offering another publication", () => {
    expect(savedEventReview({ ...row, status: "published" }, now).guidance).toBe(
      "This event is already published. This is what members see now.",
    );
  });

  it.each(["startsAt", "endsAt"] as const)("offers correction for an unreadable %s", (field) => {
    const view = savedEventReview({ ...row, [field]: new Date(Number.NaN) }, now);
    expect(view.corrections).toHaveLength(1);
    expect(view.corrections[0]?.message).toContain("time can't be read");
    expect(view.corrections[0]?.href).toBe(
      `${view.editHref}#f-${field === "startsAt" ? "starts" : "ends"}-at`,
    );
  });

  it("does not crash when the persisted update time is unrenderable", () => {
    const view = savedEventReview({ ...row, updatedAt: new Date(Number.NaN) }, now);
    expect(view.updatedAt).toBeNull();
    expect(view.href).toBe(`/e/${row.eventKey}?review=1`);
  });

  it("uses the supplied equality boundary without mutating the persisted row", () => {
    const frozen = Object.freeze({ ...row, endsAt: now });
    const view = savedEventReview(frozen, now);
    expect(view.corrections).toEqual([]);
    expect(view.guidance).toContain("Only moderators can see this page");
    expect(frozen.endsAt).toBe(now);
  });

  it("exposes the publish target, draft flag and title for the shared form", () => {
    const view = savedEventReview({ ...row, title: "Game night" }, now);
    expect(view.publishHref).toBe(`/admin/events/${row.eventKey}/publish`);
    expect(view.isDraft).toBe(true);
    expect(view.title).toBe("Game night");
    expect(savedEventReview(row, now).title).toBe("event");
    expect(savedEventReview({ ...row, status: "published" }, now).isDraft).toBe(false);
  });

  it.each(["stale", "location", "ended", "dates", "status"])(
    "maps publish_error=%s to fixed copy",
    (code) => {
      const error = savedEventReview(row, now, `?review=1&publish_error=${code}`).error;
      expect(typeof error).toBe("string");
      expect(error!.length).toBeGreaterThan(10);
    },
  );

  it.each([
    "",
    "?publish_error=",
    "?publish_error=toString",
    "?publish_error=__proto__",
    "?publish_error=<script>alert(1)</script>",
    "?publish_error=STALE",
  ])("ignores unknown publish_error %j", (search) => {
    expect(savedEventReview(row, now, search).error).toBeNull();
  });

  it("reports unsaved edits only for unsaved=1", () => {
    expect(savedEventReview(row, now, "?unsaved=1").unsaved).toBe(true);
    expect(savedEventReview(row, now, "?unsaved=0").unsaved).toBe(false);
    expect(savedEventReview(row, now).unsaved).toBe(false);
  });
});

describe("saved-event review shared publish markup", () => {
  const draft = () => savedEventReview({ ...row, title: "Game night" }, now);

  it("renders a publish form carrying the review flag and the reviewed timestamp", () => {
    const html = renderSavedEventReviewHtml(draft(), "actions");
    expect(html).toContain(`method="post"`);
    expect(html).toContain(`action="/admin/events/${row.eventKey}/publish"`);
    expect(html).toContain('name="review" value="1"');
    expect(html).toContain(`name="reviewed_updated_at" value="${row.updatedAt.toISOString()}"`);
    expect(html).toContain('aria-label="Publish Game night"');
    expect(html).toContain('data-testid="publish-reviewed-event"');
    expect(html).not.toMatch(/data-testid="publish-reviewed-event"[^>]*disabled/);
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="publish-reviewed-event"/);
    expect(html).toContain("Back to edit");
  });

  it("escapes the title and the form payload", () => {
    const view = savedEventReview(
      { ...row, eventKey: 'k"><b>', title: '"><img src=x onerror=alert(1)>' },
      now,
    );
    const html = renderSavedEventReviewHtml(view, "actions");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
  });

  it("disables publication while corrections remain", () => {
    const html = renderSavedEventReviewHtml(
      savedEventReview({ ...row, location: "", title: "T" }, now),
      "actions",
    );
    expect(html).toContain("disabled");
    expect(html).toContain("Fix the problems above, save, then review again.");
  });

  it("disables publication without a reviewed timestamp and sends an empty value", () => {
    const html = renderSavedEventReviewHtml(
      savedEventReview({ ...row, updatedAt: undefined, title: "T" }, now),
      "actions",
    );
    expect(html).toContain('name="reviewed_updated_at" value=""');
    expect(html).toContain("disabled");
  });

  it("offers no publish form for a non-draft event", () => {
    for (const status of ["published", "cancelled"]) {
      const html = renderSavedEventReviewHtml(savedEventReview({ ...row, status }, now), "actions");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("reviewed_updated_at");
      expect(html).toContain("Back to edit");
    }
  });

  it("renders allowlisted error copy as a focusable alert and never echoes raw input", () => {
    const stale = renderSavedEventReviewHtml(
      savedEventReview(row, now, "?review=1&publish_error=stale"),
      "banner",
    );
    expect(stale).toContain('data-testid="event-review-error"');
    expect(stale).toContain('tabindex="-1"');
    expect(stale).toContain("autofocus");
    expect(stale).toContain('role="alert"');
    expect(stale).toContain("This draft changed after you opened review.");
    const raw = renderSavedEventReviewHtml(
      savedEventReview(row, now, "?publish_error=<script>alert(1)</script>"),
      "banner",
    );
    expect(raw).not.toContain("event-review-error");
    expect(raw).not.toContain("<script>");
    expect(raw).not.toContain('role="alert"');
  });

  it("shows the unsaved-edits warning only when asked", () => {
    expect(
      renderSavedEventReviewHtml(savedEventReview(row, now, "?unsaved=1"), "banner"),
    ).toContain('data-testid="event-review-unsaved"');
    expect(renderSavedEventReviewHtml(savedEventReview(row, now), "banner")).not.toContain(
      "event-review-unsaved",
    );
  });
});
