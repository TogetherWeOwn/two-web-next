import assert from "node:assert/strict";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const states = [
  "beforeGuest",
  "beforeMember",
  "guest",
  "member",
  "suppressed",
  "unrelated",
  "unlinkedOnly",
  "frozen",
];
const search = (state) => `?state=${state}`;
const fixture = `<script>
import { page } from "$app/state";
import EventVoiceFixture from "../../../../test/fixtures/kit-event-voice.svelte";
</script>
<EventVoiceFixture state={page.url.searchParams.get("state")} />`;

async function assertRsvpAndPlacement(page, state, viewport) {
  const overview = page.locator(".event-overview");
  const seat = page.getByRole("region", { name: "Save a seat" });
  const voice = page.locator(".event-rail aside");
  const member = ["beforeMember", "member", "unrelated", "unlinkedOnly", "frozen"].includes(state);
  const primary = member
    ? seat.getByRole("button", { name: "I'm in" })
    : seat.getByRole("link", { name: "Log in with Discord" });

  await page.getByRole("link", { name: "← All events" }).focus();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  assert.ok(await primary.evaluate((element) => element.matches(":focus-visible")));
  await page.keyboard.press("Tab");
  await expect(seat.getByRole("link", { name: "Add to calendar" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "See more events" })).toBeFocused();

  const headBox = await overview.boundingBox();
  const seatBox = await seat.boundingBox();
  assert.ok(headBox && seatBox);
  assert.ok(
    viewport.width === 390
      ? seatBox.y >= headBox.y + headBox.height
      : seatBox.x >= headBox.x + headBox.width,
    `${state}: seat placement at ${viewport.width}px`,
  );
  if (await voice.count()) {
    const panelBox = await voice.boundingBox();
    const factsBox = await page.locator(".event-facts").boundingBox();
    assert.ok(panelBox && factsBox);
    assert.equal(panelBox.x, seatBox.x);
    assert.ok(
      panelBox.y >= factsBox.y + factsBox.height && factsBox.y >= seatBox.y + seatBox.height,
    );
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

test("Kit event detail keeps RSVP first and renders only the applicable voice projection", {
  timeout: 360_000,
}, async () => {
  await withKitOfflineBrowser(
    {
      page: fixture,
      search: search(states[0]),
      searches: states.slice(1).map(search),
      javaScriptEnabled: true,
      csr: false,
    },
    async ({ page, open }) => {
      for (const state of states) {
        const html = await open(search(state));
        const voice = page.locator(".event-rail aside");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thursday Co-op");
        const withVoice = ["guest", "member", "frozen"].includes(state);
        await expect(voice).toHaveCount(Number(withVoice));
        assert.doesNotMatch(
          html,
          /Squad 2|\bAri\b|Friday Raid lobby|\bCedar\b|friday-raid|Pull me in/i,
        );
        await expect(voice.locator("a, button, [tabindex], [aria-live]")).toHaveCount(0);
        if (state === "guest") {
          await expect(voice.getByRole("heading", { level: 2 })).toHaveText("Community voice");
          await expect(voice).toContainText("5 in voice");
          await expect(voice).toContainText("Updated 12 s ago");
        }
        if (state === "member" || state === "frozen") {
          await expect(voice.getByRole("heading", { level: 2 })).toHaveText("Event voice rooms");
          await expect(voice.getByRole("heading", { level: 3 })).toHaveText("Raid 1");
          await expect(voice).toContainText("1 visible room · 4 people");
          await expect(
            voice.getByRole("list", { name: "Members sharing their names" }),
          ).toContainText("Mika");
          await expect(voice).toContainText(
            state === "frozen" ? "Last synced 3 min ago" : "Updated 45 s ago",
          );
        } else {
          assert.doesNotMatch(html, /Raid 1|Mika|Robin|0 in voice|0 people/i);
        }

        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await page.evaluate(() => document.fonts.ready);
          await assertRsvpAndPlacement(page, state, viewport);
          await page.evaluate(() => {
            document.activeElement?.blur();
            window.scrollTo(0, 0);
          });
          await page.screenshot({
            path: `artifacts/kit-event-voice/${state}-${viewport.width}x${viewport.height}.png`,
            fullPage: true,
            animations: "disabled",
          });
          const { violations } = await new AxeBuilder({ page })
            .include(".event-composition")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          assert.deepEqual(
            violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
            [],
            `${state} at ${viewport.width}x${viewport.height}: event accessibility`,
          );
        }
      }
    },
  );
});
