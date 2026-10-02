// New-event forms mount the same dirty-navigation guard as edits:
// navigation never silently discards a create draft.
import { describe, expect, it } from "vitest";
import { EventFormPage } from "../src/admin/pages";
import { eventEditorBrowser } from "./helpers/admin-event-editor";

const NEW = {
  title: "Game night", game: "Chess", description: "Boards out",
  starts_at: "2030-01-01 18:00", ends_at: "2030-01-01 19:00",
  timezone: "Europe/London", location: "Voice", capacity: "8",
  recurrence_frequency: "", recurrence_count: "", recurrence_ends_on: "",
};

const form = (values: Record<string, string> = {}, errors: Record<string, string> = {}) =>
  String(EventFormPage({ mode: "new", values, errors }));

describe("admin new-event dirty navigation", () => {
  it("mounts the guard and island on the clean new form, without a draft marker", () => {
    const html = form();
    expect(html).toContain('data-event-editor=""');
    expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
    expect(html).not.toContain("data-event-draft");
  });

  it.each(["search", "sort"] as const)("lets an unchanged new form leave via %s without a prompt", (kind) => {
    const b = eventEditorBrowser({ initial: NEW });
    expect(b.navigate(kind).preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    "title", "game", "description", "starts_at", "ends_at", "timezone", "location", "capacity",
    "recurrence_frequency", "recurrence_count", "recurrence_ends_on",
  ])("tracks %s and allows navigation after reverting the new draft", (field) => {
    const b = eventEditorBrowser({ initial: NEW });
    const initial = b.values.get(field)!;
    b.values.set(field, `${initial} changed`);
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    b.values.set(field, initial);
    expect(b.navigate("search").preventDefault).not.toHaveBeenCalled();
  });

  it("prompts on leaving a dirty new draft and staying preserves the values", () => {
    const b = eventEditorBrowser({ initial: NEW });
    b.values.set("title", "Unsaved game night");
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    // Cancelling beforeunload leaves this document intact; no handler clears it.
    expect(b.values.get("title")).toBe("Unsaved game night");
  });

  it("exempts only the Create-draft Save departure", () => {
    const b = eventEditorBrowser({ initial: NEW });
    b.values.set("title", "Unsaved game night");
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
  });

  it("marks a rejected creation dirty so the returned draft stays protected", () => {
    const values = { ...NEW, title: "Rejected draft" };
    const html = form(values, { capacity: "Occurrences must be between 1 and 52." });
    expect(html).toContain('data-event-editor="" data-event-draft=""');
    expect(html).toContain('<script src="/islands/admin-event-editor.js" defer=""></script>');
    expect(html).toContain('value="Rejected draft"');
    // Run the actual island with the error page's dirty marker and returned fields.
    const b = eventEditorBrowser({ draft: html.includes('data-event-draft=""'), initial: values });
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    expect(b.values.get("title")).toBe("Rejected draft");
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
  });
});
