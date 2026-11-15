import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedDateBanner } from "./kit-offline-browser.mjs";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);

test("fixed server clock is module-scoped and leaves the global Date alone", () => {
  const realNow = Date.now;
  const realDate = globalThis.Date;
  const scoped = new Function(
    `${fixedDateBanner(NOW)}
    return { Date, now: Date.now(), made: new Date(), explicit: new Date(5), str: Date(), instance: new Date() instanceof Date };`,
  )();
  assert.equal(scoped.now, NOW);
  assert.equal(scoped.made.getTime(), NOW);
  assert.equal(scoped.explicit.getTime(), 5);
  assert.equal(scoped.str, new realDate(NOW).toString());
  assert.equal(scoped.instance, true);
  assert.equal(scoped.Date.UTC(1970, 0, 1), 0);
  assert.equal(globalThis.Date, realDate);
  assert.equal(Date.now, realNow);
  assert.notEqual(Date.now(), NOW);
});

test("fixed server clock rejects non-epoch values", () => {
  for (const bad of ["2030-01-01", 1.5, Number.NaN, 9e15, null]) {
    assert.throws(() => fixedDateBanner(bad), /epoch milliseconds/);
  }
});
