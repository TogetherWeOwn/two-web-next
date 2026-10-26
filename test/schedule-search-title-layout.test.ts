import { expect, it } from "vitest";
import { CalCard } from "../src/events/pages-calendar-card";
import {
  document,
  scheduleSearchEvent,
  tag,
  text,
} from "./helpers/schedule-search-context-acceptance";

it("keeps a highlighted native title in one layout item inside its flex link", () => {
  // Splitting segments directly under the theme's flex anchor lays each text
  // run/mark in a separate column. One inline wrapper preserves normal wrapping.
  const title = `${"Long community evening ".repeat(8)}NEEDLE and needle night`;
  const card = document(
    String(
      CalCard({
        e: scheduleSearchEvent({ title }),
        zone: "UTC",
        isPast: false,
        q: "needle",
        member: false,
        inviteUrl: "https://example.com/invite",
        loginReturnTo: null,
      }),
    ),
  );
  const link = tag(tag(card, "h3")[0]!, "a")[0]!;
  expect(link.childNodes).toHaveLength(1);
  const inline = tag(link, "span")[0]!;
  expect(inline).toBeDefined();
  expect(text(inline)).toBe(title);
  expect(tag(inline, "mark").map(text)).toEqual(["NEEDLE", "needle"]);
});
