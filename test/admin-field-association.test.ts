// Shared admin Field hint/error association (TOG-11751). SSR-only: no DB,
// no staging endpoint. Field mints the hint/error node ids and merges them
// into the child control's aria-describedby (append, never clobber), plus
// aria-invalid on error. Consumers pass bare controls; the text-limit island
// keeps appending its own `-limit-error` token after Field's.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventFormPage, FeaturedFormPage, Field } from "../src/admin/pages";
import type { EventRow, FeaturedRow } from "../src/admin/store";

const eventRow: EventRow = {
  id: 1,
  eventKey: "01J0000000000000000000ABCD",
  title: "Game night",
  game: "Chess",
  description: null,
  location: "Discord",
  capacity: null,
  timezone: "Europe/London",
  startsAt: new Date("2030-01-01T18:00:00Z"),
  endsAt: new Date("2030-01-01T19:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  recurrenceFrequency: "weekly",
  recurrenceCount: 4,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const featuredRow: FeaturedRow = {
  id: 1,
  legacyId: null,
  title: "Friday games",
  body: "Bring a friend.",
  url: "https://example.test/games",
  imageUrl: "https://cdn.discordapp.com/photo.jpg",
  imageAlt: "Friends playing together",
  isPublished: true,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: "moderator",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const appUrl = "https://next.example.test";
const values = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Discord",
  capacity: "",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
  timezone: "Europe/London",
  recurrence_frequency: "weekly",
  recurrence_count: "4",
  recurrence_ends_on: "",
};

const renderField = (props: {
  name: string;
  label: string;
  errors?: Record<string, string>;
  hint?: string;
  describedBy?: string;
}) =>
  String(
    Field({
      name: props.name,
      label: props.label,
      errors: props.errors ?? {},
      hint: props.hint,
      children: (id: string) =>
        jsx("input", {
          id,
          name: props.name,
          type: "text",
          value: "",
          ...(props.describedBy ? { "aria-describedby": props.describedBy } : undefined),
        }),
    }),
  );

describe("shared admin Field association", () => {
  it("hint-only state points at the hint node without an invalid marker", () => {
    const html = renderField({ name: "nickname", label: "Nickname", hint: "Pick a zone." });
    expect(html).toContain('aria-describedby="f-nickname-hint"');
    expect(html).not.toContain("aria-invalid");
    expect(html).toContain('<p id="f-nickname-hint" class="hint">Pick a zone.</p>');
    expect(html).not.toContain("f-nickname-error");
  });

  it("error-only state points at the error node and marks the control invalid", () => {
    const html = renderField({
      name: "nickname",
      label: "Nickname",
      errors: { nickname: "Required." },
    });
    expect(html).toContain('aria-describedby="f-nickname-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('data-testid="error-nickname"');
  });

  it("hint+error lists the hint first, matching reading order", () => {
    const html = renderField({
      name: "nickname",
      label: "Nickname",
      hint: "Pick a zone.",
      errors: { nickname: "Required." },
    });
    expect(html).toContain('aria-describedby="f-nickname-hint f-nickname-error"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("appends after inline wiring instead of clobbering it", () => {
    const html = renderField({
      name: "nickname",
      label: "Nickname",
      hint: "Pick a zone.",
      errors: { nickname: "Required." },
      describedBy: "island-node",
    });
    expect(html).toContain('aria-describedby="island-node f-nickname-hint f-nickname-error"');
  });

  it("dedupes an already-wired token instead of repeating it", () => {
    const html = renderField({
      name: "nickname",
      label: "Nickname",
      errors: { nickname: "Required." },
      describedBy: "f-nickname-error",
    });
    expect(html).toContain('aria-describedby="f-nickname-error"');
    expect(html).not.toContain("f-nickname-error f-nickname-error");
  });

  it("leaves a bare control untouched when Field owns nothing", () => {
    const html = renderField({ name: "nickname", label: "Nickname" });
    expect(html).toContain('<input id="f-nickname" name="nickname" type="text" value=""/>');
    expect(html).not.toContain("aria-");
  });
});

const eventNew = (errors: Record<string, string> = {}) =>
  String(EventFormPage({ mode: "new", values, errors }));
const eventEdit = (errors: Record<string, string> = {}) =>
  String(EventFormPage({ mode: "edit", row: eventRow, values, errors }));
const featuredNew = (errors: Record<string, string> = {}) =>
  String(FeaturedFormPage({ mode: "new", values, errors, now: new Date(0), appUrl }));
const featuredEdit = (errors: Record<string, string> = {}) =>
  String(
    FeaturedFormPage({ mode: "edit", row: featuredRow, values, errors, now: new Date(0), appUrl }),
  );

describe("event + featured form association", () => {
  it.each([
    ["event new", eventNew({ timezone: "Unknown timezone: Unknown/Zone." })],
    ["event edit", eventEdit({ starts_at: "Not a date and time (want YYYY-MM-DD HH:mm): bad" })],
    ["featured new", featuredNew({ image_alt: "Describe the image for screen-reader visitors." })],
    ["featured edit", featuredEdit({ url: "Use http(s).", starts_at: "Not a date." })],
  ])("%s: every describedby token resolves to a node id, with no duplicate ids", (_label, html) => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const tokens = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(ids, token).toContain(token);
    }
  });

  it("timezone hint copy and wall-field copy are untouched, error included", () => {
    const html = eventNew({ timezone: "Unknown timezone: Unknown/Zone." });
    expect(html).toContain(
      '<p id="f-timezone-hint" class="hint">The IANA zone the wall time above is typed in. Storage is UTC.</p>',
    );
    expect(html).toContain('aria-describedby="f-timezone-hint f-timezone-error"');
    expect(html).toContain("Starts (local wall time, YYYY-MM-DD HH:mm)");
    expect(html).toContain("Ends (local wall time, YYYY-MM-DD HH:mm)");
  });

  it("clean renders carry no invalid markers; hint fields stay associated", () => {
    for (const html of [eventNew(), eventEdit(), featuredNew(), featuredEdit()]) {
      expect(html).not.toContain("aria-invalid");
      expect(html).not.toContain('-error"');
    }
    expect(eventNew()).toContain('aria-describedby="f-timezone-hint"');
    expect(featuredNew()).toContain('aria-describedby="f-image-url-hint"');
    expect(featuredNew()).toContain('aria-describedby="f-image-alt-hint"');
  });

  it("edit series copy keeps its own untouched paragraph outside Field", () => {
    const html = eventEdit();
    expect(html).toContain('data-testid="series-info"');
    expect(html).toContain("Part of a weekly series.");
  });
});
