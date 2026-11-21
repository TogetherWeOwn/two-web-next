import { expect, test } from "@playwright/test";
import { homeArrivalHeading } from "./staging/home-arrival";

const homeUrl = "https://home-arrival.example.test/";
const lobby = "The lobby is open.";
const scheduled = "Next game night: <em>Games &amp; Friends</em>.\n<span>Come play with us.</span>";
const going = "Your next RSVP: <em>Games &amp; Friends</em>. <span>You're going.</span>";
const waitlisted =
  "Your next RSVP: <em>Games &amp; Friends</em>. <span>You're on the waitlist.</span>";

for (const [scenario, renderer, visitor, copy, accepted, tag = "h1"] of [
  ["Hono lobby", "hono", "guest", lobby, true],
  ["old Kit lobby", "kit", "member", lobby, true],
  ["Kit empty", "kit", "guest", "The lobby is <em>open</em>.", true],
  ["Kit scheduled guest", "kit", "guest", scheduled, true],
  ["Kit scheduled member", "kit", "member", scheduled, true],
  ["Kit RSVP going", "kit", "member", going, true],
  ["Kit RSVP waitlisted", "kit", "member", waitlisted, true],
  ["Kit RSVP on guest arrival", "kit", "guest", going, false],
  ["Kit lookalike heading at the wrong level", "kit", "guest", scheduled, false, "h2"],
  ["Hono with Kit scheduled copy", "hono", "guest", scheduled, false],
] as const) {
  test(`staging Home arrival fixture: ${scenario}`, async ({ page }) => {
    // Exercise the browser's actual navigation response without contacting either renderer.
    await page.route("**/*", (route) =>
      route.request().url() === homeUrl
        ? route.fulfill({
            contentType: "text/html",
            headers: renderer === "kit" ? { "x-two-renderer": "kit" } : {},
            body: `<${tag} id="home-heading">${copy}</${tag}>`,
          })
        : route.abort(),
    );
    const heading = await homeArrivalHeading(page, await page.goto(homeUrl), visitor);
    if (accepted) await expect(heading).toBeVisible();
    else await expect(heading).toHaveCount(0);
  });
}
