import { describe, expect, it } from "vitest";
import { fixture } from "./helpers/featured-reuse-fixture";

// Exercise the production admin layout, not a fixture-created 503. Replacing
// the layout's unavailable mapping with admission must expose a saved row and
// fail these refusals before the child editor can read anything.
describe("Kit featured reuse real layout refusal", () => {
  for (const url of ["/admin/featured/new?source=41", "/admin/featured/41"]) {
    it(`${url} refuses an indeterminate session before reading saved content`, async () => {
      const f = await fixture();
      const response = await f.get("kit", url, "unavailable");
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Admin temporarily unavailable");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(f.reads()).toHaveLength(0);
      expect(f.writes()).toHaveLength(0);
    });
  }
});
