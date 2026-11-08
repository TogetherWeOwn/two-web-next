import assert from "node:assert/strict";
import { chromium } from "playwright";

export async function verifyMotion(normalizeMotion) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="animated" style="opacity: 0.5">Motion</div>');
    await page.evaluate(() => {
      // Simulate a clock whose timer-based rAF runs before a real rendering update.
      window.motionFrame = requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => queueMicrotask(callback);
      window.setTimeout = (callback) => queueMicrotask(callback);
      window.armMotion = () =>
        window.motionFrame(() => {
          document.querySelector("#animated").animate([{ opacity: 0.5 }, { opacity: 1 }], {
            duration: 100000000,
            fill: "forwards",
          });
        });
      window.armMotion();
    });
    const wrapped = new Proxy(page, {
      get(target, key) {
        // Arm atomically with any main-world settling attempt, even on a slow host.
        if (key === "evaluate")
          return (settle) => target.evaluate(`window.armMotion(); (${settle.toString()})()`);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await normalizeMotion(wrapped);
    await page.evaluate(() => new Promise(window.motionFrame));
    const facts = await page.evaluate(() => ({
      opacity: getComputedStyle(document.querySelector("#animated")).opacity,
      active: document
        .getAnimations()
        .filter((animation) => !["finished", "idle"].includes(animation.playState)).length,
    }));
    assert.equal(facts.opacity, "1", "Motion settling must wait for native rendering updates");
    assert.equal(facts.active, 0);
  } finally {
    await browser.close();
  }
}
