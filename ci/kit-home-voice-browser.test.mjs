import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { homeVoiceFixture } from "../test/fixtures/kit-home-voice.ts";
import { homeEvidenceData } from "./kit-home-evidence.mjs";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const states = /** @type {const} */ ([
  "beforeGuest",
  "beforeMember",
  "guest",
  "member",
  "quiet",
  "absent",
  "belowFloor",
  "frozen",
]);
const searchFor = (state) => `?state=${state}`;

async function fixturePage() {
  const cases = Object.fromEntries(
    await Promise.all(
      states.map(async (state) => {
        const member = ["beforeMember", "member", "quiet", "frozen"].includes(state);
        const data = homeEvidenceData(member ? "memberEvents" : "guestEvents");
        const voice =
          state === "beforeGuest" || state === "beforeMember"
            ? undefined
            : await homeVoiceFixture(state);
        return [state, { data, voice }];
      }),
    ),
  );
  // Only this disposable fixture route uses the query string. The built Home
  // component receives props, not wire data or a URL-driven feature flag.
  return `<script>
import { page } from '$app/state';
import Home from '../+page.svelte';
import { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO } from '../../../../src/home-copy';
const cases = ${JSON.stringify(cases)};
const { data, voice } = cases[page.url.searchParams.get('state')];
data.upcomingEvents = data.upcomingEvents.map(event => ({ ...event, startsAt: new Date(event.startsAt) }));
data.homeCopy = { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO };
</script>
<Home {data} {voice} />`;
}

test("Kit home places and captures each offline voice state at both widths", {
  timeout: 720_000,
}, async () => {
  const output = "artifacts/kit-home-voice";
  await mkdir(output, { recursive: true });
  await withKitOfflineBrowser(
    {
      page: await fixturePage(),
      search: searchFor(states[0]),
      searches: states.slice(1).map(searchFor),
      now: Date.UTC(2026, 9, 20, 12),
    },
    async ({ page, open }) => {
      for (const state of states) {
        await open(searchFor(state));
        const hero = page.locator(".hero.kit-home");
        const h1 = hero.getByRole("heading", { level: 1 });
        const panel = hero.locator(".home-voice-panels aside").first();
        assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
        assert.equal(await h1.getAttribute("id"), "home-heading");
        const withVoice = ["guest", "member", "quiet", "frozen"].includes(state);
        assert.equal(await panel.count(), Number(withVoice));
        assert.match(
          await h1.innerText(),
          {
            guest: /5 of us are in voice right now/,
            member: /3 in voice rooms you can see/,
            quiet: /It's quiet in the rooms you can see/,
            frozen: /Live numbers are catching up/,
          }[state] ?? /Next game night: Game night/,
        );
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          if (withVoice) {
            const sentenceBox = await h1.boundingBox();
            const panelBox = await panel.boundingBox();
            assert.ok(sentenceBox && panelBox);
            assert.ok(
              viewport.width === 390
                ? panelBox.y >= sentenceBox.y + sentenceBox.height
                : panelBox.x >= sentenceBox.x + sentenceBox.width,
              `${state}: voice panel placement`,
            );
          }
          await page.screenshot({
            path: `${output}/${state}-${viewport.width}x${viewport.height}.png`,
            fullPage: true,
            animations: "disabled",
          });
        }
        const { violations } = await new AxeBuilder({ page })
          .include(".hero.kit-home")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        assert.deepEqual(
          violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
          [],
        );
      }
    },
  );
});
