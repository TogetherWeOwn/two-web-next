import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAuditContent, contentExpectations } from "./a11y-content.mjs";
import { coverage } from "./a11y-cases.mjs";

function fixturePage(scenario, changed = {}) {
  const expected = contentExpectations(scenario);
  return { locator(selector) {
    const entries = expected.filter((entry) => entry.selector === selector);
    const entry = Object.assign({}, ...entries, changed[selector]);
    return {
      count: async () => entry.count ?? 1,
      nth: () => ({ isVisible: async () => entry.visible ?? true }),
      textContent: async () => entry.text ?? entries.map((item) => item.includes || "").join(" "),
      getAttribute: async (name) => entry.attributes?.[name],
    };
  } };
}
const home = { route: "/", path: "/", status: 200 };
const owner = { route: "/profile", path: "/profile", status: 200 };

test("home assertions require member, online, numeric and zero-rank content before axe", async () => {
  const assertions = await assertAuditContent(fixturePage(home), home);
  assert(assertions.some((item) => item.text === "84 members · 12 online"));
  assert(assertions.some((item) => item.text === "unclaimed"));
  await assert.rejects(assertAuditContent(fixturePage(home, { '[data-testid="member-count"]': { count: 0 } }), home), /Fixture content count/);
  await assert.rejects(assertAuditContent(fixturePage(home, { '[data-rank="member"] dd': { text: "" } }), home), /Fixture content text/);
});

test("fallback rank/joined text cannot substitute for populated profile stats", async () => {
  await assertAuditContent(fixturePage(owner), owner);
  await assert.rejects(assertAuditContent(fixturePage(owner, { '[data-testid="profile-stats"]': { count: 0 } }), owner), /Fixture content count/);
  await assert.rejects(assertAuditContent(fixturePage(owner, { '[data-testid="profile-stats"] ol > li': { count: 0 } }), owner), /Fixture content count/);
  await assert.rejects(assertAuditContent(fixturePage(owner, { '[data-testid="profile-stats"]': { visible: false } }), owner), /Fixture content hidden/);
});

test("unavailable and populated states coexist; unavailable content must really be absent", async () => {
  for (const scenario of [home, owner]) {
    const unavailable = { ...scenario, readState: "unavailable" };
    const expectations = await assertAuditContent(fixturePage(unavailable), unavailable);
    const absent = expectations.find((item) => item.count === 0);
    await assert.rejects(assertAuditContent(fixturePage(unavailable, { [absent.selector]: { count: 1 } }), unavailable), /Fixture content count/);
    assert(coverage[scenario.route].cases.some((item) => item.readState === "unavailable"));
    assert(coverage[scenario.route].cases.some((item) => !item.readState));
  }
});

test("empty fallback totals may have no box but their rank cards must remain visible", async () => {
  const unavailable = { ...home, readState: "unavailable" };
  await assertAuditContent(fixturePage(unavailable, { '[data-rank="prospect"] dd': { visible: false } }), unavailable);
  await assert.rejects(assertAuditContent(fixturePage(unavailable, { '[data-testid="rank-stack"] > div': { visible: false } }), unavailable), /Fixture content hidden/);
});

test("other-member empty milestones, validation errors and non-profile pages retain their cases", async () => {
  const other = { route: "/members/:user", path: "/members/100000000000000102", status: 200 };
  assert(contentExpectations(other).some((item) => item.text === "No milestones yet."));
  await assertAuditContent(fixturePage(other), other);
  assert.deepEqual(contentExpectations({ ...other, status: 404 }), []);
  assert.deepEqual(contentExpectations({ route: "/events", status: 200 }), []);
  assert.deepEqual(contentExpectations({ ...owner, state: "validation-error" }), contentExpectations(owner));
});
