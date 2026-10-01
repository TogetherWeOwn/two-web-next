import assert from "node:assert/strict";

function luminance(color) {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  assert(match, `Interaction contrast requires opaque computed RGB: ${color}`);
  const channels = match.slice(1).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function textContrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export async function assertHomeInteractions(page, scenario) {
  const home = scenario.route === "/" && scenario.status === 200;
  const event = scenario.route === "/e/:key" && [200, 410].includes(scenario.status);
  if (!home && !event) return [];
  const results = [];
  const skip = page.locator(".skip-link");
  const check = async (selector, state) => {
    const colors = await page.locator(selector).evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
    const contrast = textContrast(colors.foreground, colors.background);
    assert(contrast >= 4.5, `${selector} ${state} text contrast ${contrast.toFixed(2)}:1 is below 4.5:1`);
    results.push({ selector, state, ...colors, contrast });
  };
  try {
    await page.keyboard.press("Tab");
    assert(await skip.evaluate((element) => element === document.activeElement), "First Tab must reveal and focus the skip link");
    await check(".skip-link", "keyboard focus");
    if (scenario.identity === "guest" && scenario.status === 200) {
      await page.locator('[data-testid="signin"]').hover();
      await check('[data-testid="signin"]', "hover");
    }
    if (event && (scenario.status === 410 || scenario.identity === "guest")) {
      const selector = scenario.status === 410 ? ".event-gone .btn" : ".event-pitch .btn";
      await page.locator(selector).hover();
      await check(selector, "hover");
    }
    await skip.hover();
    await check(".skip-link", "keyboard focus + hover");
  } finally {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
  }
  return results;
}
