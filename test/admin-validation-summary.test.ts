import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { validationSummary } from "../src/admin/form-errors";
import { ValidationSummary } from "../src/admin/pages/validation-summary";

describe("admin correction target boundaries", () => {
  describe.each(["new", "edit"] as const)("%s editor", (mode) => {
    it("targets accessibility-notes errors at the event textarea", () => {
      const errors = { accessibility_notes: "Keep accessibility notes to 1000 characters." };
      expect(validationSummary(errors, "event", mode)).toEqual([
        {
          key: "accessibility_notes",
          message: "Keep accessibility notes to 1000 characters.",
          label: "Accessibility notes",
          target: "f-accessibility-notes",
        },
      ]);
    });

    it("renders the accessibility-notes correction link with the supplied message", () => {
      const errors = { accessibility_notes: "Keep accessibility notes to 1000 characters." };
      const html = String(jsx(ValidationSummary, { errors, kind: "event", mode }));
      expect(html).toContain(
        '<a href="#f-accessibility-notes">Accessibility notes: Keep accessibility notes to 1000 characters.</a>',
      );
    });

    it("keeps accessibility notes untargeted in the featured editor", () => {
      const errors = { accessibility_notes: "This field does not belong to featured content." };
      expect(validationSummary(errors, "featured", mode)).toEqual([
        {
          key: "accessibility_notes",
          message: "This field does not belong to featured content.",
          label: null,
          target: null,
        },
      ]);
      const html = String(jsx(ValidationSummary, { errors, kind: "featured", mode }));
      expect(html).toContain("<li>This field does not belong to featured content.</li>");
      expect(html).not.toContain("<a ");
    });

    for (const [key, label, target, message] of [
      [
        "organizer_name",
        "Organizer display name",
        "f-organizer-name",
        "Keep the organizer name to 500 characters.",
      ],
      [
        "join_url",
        "Public joining link",
        "f-join-url",
        "Enter a valid public HTTP or HTTPS link without sign-in credentials.",
      ],
      [
        "join_instructions",
        "Public joining instructions",
        "f-join-instructions",
        "Keep joining instructions to 5000 characters.",
      ],
    ] as const) {
      it(`targets ${key} errors at the event control`, () => {
        expect(validationSummary({ [key]: message }, "event", mode)).toEqual([
          { key, message, label, target },
        ]);
      });

      it(`renders the ${key} correction link with the supplied message`, () => {
        const html = String(
          jsx(ValidationSummary, { errors: { [key]: message }, kind: "event", mode }),
        );
        expect(html).toContain(`<a href="#${target}">${label}: ${message}</a>`);
      });
    }

    it("keeps host and join errors untargeted in the featured editor", () => {
      const errors = {
        organizer_name: "This field does not belong to featured content.",
        join_url: "This field does not belong to featured content.",
        join_instructions: "This field does not belong to featured content.",
      };
      expect(validationSummary(errors, "featured", mode)).toEqual([
        {
          key: "organizer_name",
          message: "This field does not belong to featured content.",
          label: null,
          target: null,
        },
        {
          key: "join_url",
          message: "This field does not belong to featured content.",
          label: null,
          target: null,
        },
        {
          key: "join_instructions",
          message: "This field does not belong to featured content.",
          label: null,
          target: null,
        },
      ]);
      const html = String(jsx(ValidationSummary, { errors, kind: "featured", mode }));
      expect(html).not.toContain("<a ");
    });

    it("keeps global and unknown event errors visible without correction links", () => {
      const errors = { _global: "Try again later.", future_field: "Unrecognized field." };
      expect(validationSummary(errors, "event", mode)).toEqual([
        { key: "_global", message: "Try again later.", label: null, target: null },
        { key: "future_field", message: "Unrecognized field.", label: null, target: null },
      ]);
      const html = String(jsx(ValidationSummary, { errors, kind: "event", mode }));
      expect(html).toContain("<li>Try again later.</li>");
      expect(html).toContain("<li>Unrecognized field.</li>");
      expect(html).not.toContain("<a ");
    });
  });

  it("keeps recurrence errors visible but untargeted on edit without recurrence controls", () => {
    const errors = { recurrence_count: "Choose at most 52 occurrences." };
    expect(validationSummary(errors, "event", "edit")).toEqual([
      { key: "recurrence_count", message: errors.recurrence_count, label: null, target: null },
    ]);
    expect(validationSummary(errors, "event", "new")[0]?.target).toBe("f-recurrence-count");
  });

  it("does not mistake prototype names or immutable keys for controls", () => {
    const errors = JSON.parse(
      '{"toString":"Try again.","__proto__":"Refused.","event_key":"Immutable."}',
    );
    const entries = validationSummary(errors, "event", "new");
    expect(entries.map(({ message }) => message)).toEqual(["Try again.", "Refused.", "Immutable."]);
    expect(entries.every(({ target, label }) => target === null && label === null)).toBe(true);
  });

  it("never links a field belonging to the other editor", () => {
    expect(validationSummary({ image_url: "Refused." }, "event", "new")[0]?.target).toBeNull();
    expect(validationSummary({ capacity: "Refused." }, "featured", "new")[0]?.target).toBeNull();
  });

  it("does not manufacture an error for an error-free form", () => {
    expect(validationSummary({}, "event", "new")).toEqual([]);
    expect(validationSummary({}, "featured", "edit")).toEqual([]);
  });
});
