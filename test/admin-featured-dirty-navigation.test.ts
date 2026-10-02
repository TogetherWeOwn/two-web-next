// Featured new/edit forms mount the same dirty-navigation guard as event forms:
// navigation never silently discards a featured draft.
import { describe, expect, it } from "vitest";
import { FeaturedFormPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
import { eventEditorBrowser } from "./helpers/admin-event-editor";

const now = new Date("2026-09-30T20:00:00Z");
const appUrl = "https://next.example.test";
const saved: FeaturedRow = {
  id: 1, legacyId: null, title: "Friday games", body: "Bring a friend.",
  url: "https://example.test/games", imageUrl: "https://cdn.discordapp.com/photo.jpg",
  imageAlt: "Friends playing together",
  isPublished: true, position: 0, startsAt: null, endsAt: null, createdBy: "moderator",
  createdAt: now, updatedAt: now,
};

const DRAFT = {
  title: "Friday games", body: "Bring a friend.", url: "https://example.test/games",
  image_url: "https://cdn.discordapp.com/photo.jpg", image_alt: "Friends playing together",
  position: "0", starts_at: "", ends_at: "",
};

const renderNew = (values: Record<string, unknown> = {}, errors: Record<string, string> = {}) =>
  String(FeaturedFormPage({ mode: "new", values, errors, now, appUrl }));
const renderEdit = (values: Record<string, unknown> = {}, errors: Record<string, string> = {}) =>
  String(FeaturedFormPage({ mode: "edit", row: saved, values, errors, now, appUrl }));

describe("admin featured dirty navigation", () => {
  it("mounts the guard and island on the clean new form, without a draft marker", () => {
    const html = renderNew();
    expect(html).toContain('data-event-editor=""');
    expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
    expect(html).not.toContain("data-event-draft");
  });

  it("mounts the guard and island on the clean edit form, without a draft marker", () => {
    const html = renderEdit();
    expect(html).toContain('data-event-editor=""');
    expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
    expect(html).not.toContain("data-event-draft");
    expect(html).toContain('data-testid="featured-preview"');
  });

  it.each(["search", "sort"] as const)("lets an unchanged featured draft leave via %s without a prompt", (kind) => {
    const b = eventEditorBrowser({ initial: DRAFT });
    expect(b.navigate(kind).preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    "title", "body", "url", "image_url", "image_alt", "position", "starts_at", "ends_at",
  ])("tracks %s and allows navigation after reverting the featured draft", (field) => {
    const b = eventEditorBrowser({ initial: DRAFT });
    const initial = b.values.get(field)!;
    b.values.set(field, `${initial} changed`);
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    b.values.set(field, initial);
    expect(b.navigate("search").preventDefault).not.toHaveBeenCalled();
  });

  it("prompts on leaving a dirty featured draft and staying preserves the values", () => {
    const b = eventEditorBrowser({ initial: DRAFT });
    b.values.set("title", "Unsaved headline");
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    // Cancelling beforeunload leaves this document intact; no handler clears it.
    expect(b.values.get("title")).toBe("Unsaved headline");
  });

  it("exempts only the Save departure", () => {
    const b = eventEditorBrowser({ initial: DRAFT });
    b.values.set("title", "Unsaved headline");
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
  });

  it("marks a rejected creation dirty so the returned draft stays protected", () => {
    const values = { ...DRAFT, title: "Rejected headline" };
    const html = renderNew(values, { image_url: "HTTPS on an approved public host." });
    expect(html).toContain('data-event-editor="" data-event-draft=""');
    expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
    expect(html).toContain('value="Rejected headline"');
    // Run the actual island with the error page's dirty marker and returned fields.
    const b = eventEditorBrowser({ draft: html.includes('data-event-draft=""'), initial: values });
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    expect(b.values.get("title")).toBe("Rejected headline");
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
  });

  it("marks a rejected edit dirty so the returned draft stays protected", () => {
    const values = { ...DRAFT, body: "Rejected body" };
    const html = renderEdit(values, { image_url: "HTTPS on an approved public host." });
    expect(html).toContain('data-event-editor="" data-event-draft=""');
    expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
    expect(html).toContain("Rejected body");
    expect(html).toContain('data-testid="featured-preview"');
    const b = eventEditorBrowser({ draft: html.includes('data-event-draft=""'), initial: values });
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
  });
});
