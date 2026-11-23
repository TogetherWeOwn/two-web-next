const assert = require("node:assert/strict");
const { test } = require("node:test");
const { galleryConfig } = require("./kit-gallery-lighthouse-config.cjs");
const mobile = require("./lighthouserc.cjs").ci;
const desktop = require("./lighthouserc.quality.cjs").ci;

test("gallery profiles retain the existing quotas, settings and assertions", () => {
  for (const [mode, base] of [
    ["mobile", mobile],
    ["desktop", desktop],
  ]) {
    const config = galleryConfig(mode, "http://127.0.0.1:8788/events/past").ci;
    assert.deepEqual(config.collect.url, ["http://127.0.0.1:8788/events/past"]);
    assert.equal(config.collect.numberOfRuns, base.collect.numberOfRuns);
    assert.deepEqual(config.collect.settings, base.collect.settings);
    assert.deepEqual(config.assert, base.assert);
    assert.equal(config.collect.startServerCommand, undefined);
    config.collect.settings.onlyCategories.push("changed");
    assert.notDeepEqual(config.collect.settings, base.collect.settings);
  }
});

test("gallery profiles reject unplanned modes and non-loopback targets", () => {
  assert.throws(() => galleryConfig("tablet", "http://127.0.0.1/"), /mode/);
  for (const url of [
    "https://127.0.0.1/",
    "http://localhost/",
    "http://example.com/",
    "http://user@127.0.0.1/",
    "http://127.0.0.1/#x",
    "not a URL",
  ]) {
    assert.throws(() => galleryConfig("mobile", url));
  }
});
