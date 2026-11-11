import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { StaleSaveNotice } from "../src/admin/pages/stale-save-notice";

for (const kind of ["event", "featured"] as const) {
  describe(`${kind} stale-save recovery notice`, () => {
    const action = kind === "event" ? "/admin/events/evt_abc" : "/admin/featured/7";
    const render = (errors: Record<string, string> = {}, unverified = false) =>
      String(
        jsx(StaleSaveNotice, {
          kind,
          action,
          errors,
          unverified,
          updatedAt: new Date("2030-01-01T10:00:00Z"),
        }),
      );

    it("offers explicit new-tab preservation and same-tab discard without a retry or overwrite", () => {
      const html = render();
      expect(html).toContain('data-testid="stale-save"');
      expect(html).toContain('data-admin-validation-summary=""');
      expect(html).toContain('role="alert"');
      expect(html).toContain('tabindex="-1"');
      expect(html).toContain(`href="${action}" target="_blank" rel="noopener"`);
      expect(html).toContain('data-testid="stale-open-latest"');
      expect(html).toContain('data-testid="stale-discard-draft"');
      expect(html).toContain("Discard my changes and load the latest version");
      expect(html).toContain("Saving this page again will be refused");
      expect(html).not.toContain("<button");
      expect(html).toContain('datetime="2030-01-01T10:00:00.000Z"');
    });

    it("combines field corrections in one escaped summary", () => {
      const html = render({ title: "Enter <safe> text." });
      expect(html.match(/role="alert"/g)).toHaveLength(1);
      expect(html).toContain("Also fix before saving:");
      expect(html).toContain('href="#f-title"');
      expect(html).toContain("Enter &lt;safe&gt; text.");
      expect(html).not.toContain("<safe>");
    });

    it("explains an unverifiable form without claiming another moderator saved", () => {
      const html = render({}, true);
      expect(html).toContain("saved version could not be verified");
      expect(html).not.toContain("Someone else saved");
    });
  });
}
