import { describe, expect, it } from "vitest";
import {
  nativeShareButtonMarkup,
  nativeShareFixture,
  SHARE_VIEWS,
} from "./fixtures/event-native-share";

for (const view of SHARE_VIEWS) {
  describe(`${view} native Share published-state allowlist`, () => {
    it.each(["past", "pending", "archived"])(
      "%s is not eligible even when it is neither draft nor cancelled",
      async (status) => {
        const fixture = await nativeShareFixture(view, { status });
        expect(fixture.status).toBe(200);
        expect(nativeShareButtonMarkup(fixture.html)).toEqual([]);
        expect(fixture.html).not.toContain("data-native-share-status");
      },
    );
  });
}
