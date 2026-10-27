// Schedule-preview contract shared by the acceptance suites.
//
// A moderator filling the new-event form can inspect the bounded weekly date
// expansion BEFORE anything is written: an explicit native `Preview schedule`
// submit on both new-event forms, served by the existing Hono-owned
// POST /admin/events path (same guard, same-origin, body cap, throttle,
// `private, no-store`), validated by the existing event + recurrence parsers,
// with zero writes (no event rows, no mutation audits, no write-back dispatch,
// no cache retirement).
//
// Wire contract (the Builder implements exactly this):
// - Discriminator: `preview=schedule` in the posted form. Absent means the
//   ordinary create-as-draft; the update path ignores it.
// - Button (both twins): a native
//   `<button type="submit" name="preview" value="schedule"
//   data-testid="preview-schedule">Preview schedule</button>`
//   beside the existing Create draft submit. No JavaScript.
// - Valid preview: 200 text/html with a
//   `<section data-testid="schedule-preview">` holding an accessible
//   "Schedule preview" heading, visible "Not saved" copy, a
//   `data-testid="preview-count"` element (`N occurrence(s)`), first/last
//   elements (`data-testid="preview-first"` / `"preview-last"`, each with a
//   `<time datetime>` for that occurrence start), and a native
//   `<details data-testid="preview-list">` disclosure whose `<summary>` names
//   the count and whose list holds exactly one `<li>` per occurrence. Every
//   item shows the host-zone wall time as text plus a `<time datetime>`
//   UTC instant (first time per item is the occurrence start; an optional
//   second time is the occurrence end). The panel never claims a draft was
//   saved and holds no submit control. The 200 keeps the full create form
//   (retained values, Create draft submit, progressive islands) so the
//   moderator can create right after previewing without JavaScript.
// - Invalid preview: 422 with today's create-error shape (validation notice,
//   per-field errors, retained values, dirty-draft marker, Create draft) and
//   NO preview panel: invalid input never shows a stale successful output.
// - Oracle: every displayed instant equals the existing `occurrences()`
//   enumerator fed by `parseEventForm` + `parseRecurrenceForm`. No second
//   recurrence algorithm; one-off input previews its single meeting.
import { expect } from "vitest";
import { occurrences, parseRecurrenceForm } from "../../src/admin/recurrence";
import { parseEventForm, utcToWall } from "../../src/admin/validation";

/** Submitted values for a valid weekly-count preview across the BST->GMT change. */
export const SCHEDULE_PREVIEW_BASE_FORM: Record<string, string> = {
  title: "Sunday Squad",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2026-10-04 20:00",
  ends_at: "2026-10-04 21:00",
  timezone: "Europe/London",
};

export const previewValues = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ...SCHEDULE_PREVIEW_BASE_FORM,
  ...overrides,
  preview: "schedule",
});

export const escapeHtml = (raw: string): string =>
  raw
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Visible text: strip comments and tags, collapse whitespace. */
export function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every `<time datetime>` value in document order. */
export function datetimes(fragment: string): string[] {
  return [...fragment.matchAll(/<time\b[^>]*datetime="([^"]+)"[^>]*>/g)].map((m) => m[1]!);
}

/** The preview panel, or null when the response carries none. */
export function previewSection(html: string): string | null {
  const m = html.match(/<section\b[^>]*data-testid="schedule-preview"[^>]*>([\s\S]*?)<\/section>/);
  return m ? m[0] : null;
}

/** The `<li>` bodies inside the preview disclosure, in order. Empty when absent. */
export function previewListItems(panel: string): string[] {
  const list = panel.match(/<details\b[^>]*data-testid="preview-list"[^>]*>([\s\S]*?)<\/details>/);
  if (!list) return [];
  return [...list[1]!.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
}

function effectiveTimezone(values: Record<string, string>): string {
  const raw = values.timezone;
  return raw && raw.trim() !== "" ? raw : "Europe/London";
}

/**
 * The existing expansion the preview must reproduce exactly: one entry for a
 * one-off, otherwise the weekly enumerator over the parsed rule. Throws on
 * invalid input, like the route's parsers do.
 */
export function expectedOccurrences(
  values: Record<string, string>,
): { startsAt: Date; endsAt: Date }[] {
  const input = parseEventForm(values);
  const rule = parseRecurrenceForm(values);
  if (!rule) return [{ startsAt: input.startsAtUtc, endsAt: input.endsAtUtc }];
  return [
    ...occurrences(
      input.startsAtUtc,
      input.endsAtUtc,
      input.timezone,
      rule.frequency,
      rule.count,
      rule.endsOn,
    ).values(),
  ];
}

/** The native preview submit, pinned identically in served HTML and Svelte source. */
export function assertPreviewButtonMarkup(source: string): void {
  const open = source.match(/<button\b[^>]*data-testid="preview-schedule"[^>]*>/);
  expect(open, "native Preview schedule submit").not.toBeNull();
  expect(open![0]).toContain('type="submit"');
  expect(open![0]).toContain('name="preview"');
  expect(open![0]).toContain('value="schedule"');
  expect(open![0]).not.toMatch(/on:[a-z]+=|onclick/i);
  const full = source.match(
    /<button\b[^>]*data-testid="preview-schedule"[^>]*>([\s\S]*?)<\/button>/,
  );
  expect(full, "button element closes").not.toBeNull();
  expect(textOf(full![0])).toContain("Preview schedule");
}

/**
 * The full valid-preview contract: Not-saved panel, count, first/last, native
 * disclosure, and every instant equal to the existing enumerator. `values` is
 * the submitted form (including `preview=schedule`).
 */
export function expectPreviewPanel(html: string, values: Record<string, string>): void {
  const panel = previewSection(html);
  expect(panel, "schedule preview panel renders").not.toBeNull();
  const p = panel!;
  expect(p).toMatch(/<h[2-6]\b[^>]*>[\s\S]*?schedule preview[\s\S]*?<\/h[2-6]>/i);
  expect(textOf(p)).toMatch(/not saved/i);
  // Truthful: a preview never reads as a saved draft or publication.
  expect(p).not.toMatch(/draft saved|created|published|write-?back/i);
  expect(p).not.toContain("Create draft");
  expect(p).not.toContain('type="submit"');

  const want = expectedOccurrences(values);
  const countAnchor = p.indexOf('data-testid="preview-count"');
  expect(countAnchor, "preview count element").toBeGreaterThanOrEqual(0);
  const countText = textOf(p.slice(countAnchor, countAnchor + 500));
  const countMatch = /(\d+)\s+occurrences?/.exec(countText);
  expect(countMatch, `count names ${want.length}`).not.toBeNull();
  expect(countMatch![1]).toBe(String(want.length));
  if (want.length === 1) expect(countText).toMatch(/1 occurrence(?!s)/);

  for (const [testid, instant] of [
    ["preview-first", want[0]!.startsAt],
    ["preview-last", want[want.length - 1]!.startsAt],
  ] as const) {
    const anchor = p.indexOf(`data-testid="${testid}"`);
    expect(anchor, `${testid} element`).toBeGreaterThanOrEqual(0);
    expect(datetimes(p.slice(anchor)), `${testid} instant`).toContain(instant.toISOString());
  }

  expect(p).toContain("<details");
  const summary = p.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/);
  expect(summary, "native disclosure summary").not.toBeNull();
  expect(textOf(summary![0])).toContain(String(want.length));

  const items = previewListItems(p);
  expect(items, "one list item per occurrence").toHaveLength(want.length);
  const timezone = effectiveTimezone(values);
  items.forEach((li, index) => {
    const times = datetimes(li);
    expect(times.length, `item ${index + 1} has a UTC instant`).toBeGreaterThanOrEqual(1);
    expect(times.length, `item ${index + 1} shows at most start + end`).toBeLessThanOrEqual(2);
    expect(times[0], `item ${index + 1} start`).toBe(want[index]!.startsAt.toISOString());
    if (times.length > 1) {
      expect(times[1], `item ${index + 1} end`).toBe(want[index]!.endsAt.toISOString());
    }
    const liText = textOf(li);
    expect(liText, `item ${index + 1} wall time`).toContain(
      utcToWall(want[index]!.startsAt, timezone),
    );
    expect(
      liText.includes("UTC") || liText.includes(want[index]!.startsAt.toISOString()),
      `item ${index + 1} shows its UTC instant as text, not only an attribute`,
    ).toBe(true);
  });
}

/** The 200 keeps a working create form: retained values, both submits, islands. */
export function expectCreateFormIntact(html: string, values: Record<string, string>): void {
  expect(html).toContain('action="/admin/events"');
  expect(html).toContain('data-testid="save-event"');
  expect(html).toContain("Create draft");
  assertPreviewButtonMarkup(html);
  expect(html).toContain("/islands/admin-event-text-limits.js");
  expect(html).toContain("/islands/admin-event-editor.js");
  for (const name of [
    "title",
    "game",
    "starts_at",
    "ends_at",
    "timezone",
    "location",
    "capacity",
    "recurrence_count",
    "recurrence_ends_on",
  ]) {
    const value = values[name];
    if (value === undefined || value === "") continue;
    expect(html, `retained ${name}`).toContain(`value="${escapeHtml(value)}"`);
  }
  const description = values.description;
  if (description !== undefined && description !== "") {
    expect(html, "retained description").toContain(escapeHtml(description));
  }
  if (values.recurrence_frequency === "weekly") {
    expect(html, "retained weekly repeat").toContain('value="weekly"');
  }
}
