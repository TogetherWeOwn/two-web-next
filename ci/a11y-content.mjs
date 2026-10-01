import assert from "node:assert/strict";

export function contentExpectations(scenario) {
  const unavailable = scenario.readState === "unavailable";
  if (scenario.route === "/") {
    const values = unavailable ? ["", "", "", "", ""] : ["4", "50", "20", "10", "unclaimed"];
    return [
      unavailable ? { selector: '[data-testid="member-count"]', count: 0 }
        : { selector: '[data-testid="member-count"]', text: "84 members · 12 online" },
      { selector: '[data-testid="rank-stack"] > div', count: 5 },
      ...["prospect", "member", "soldier", "veteran", "legend"].map((rank, i) => ({ selector: `[data-rank="${rank}"] dd`, text: values[i] })),
    ];
  }
  if (scenario.route === "/e/:key" && scenario.status === 200) {
    return [
      { selector: ".event-hero h1", attributes: { "data-waitlist-position": scenario.state === "waitlisted" ? "1" : "" } },
      { selector: '[data-testid="event-attendees"]', count: scenario.identity === "guest" || scenario.identity === "moderator" ? 0 : 1 },
      { selector: '[data-testid="event-join-pitch"]', count: scenario.identity === "guest" ? 1 : 0 },
    ];
  }
  if (!["/profile", "/members/:user"].includes(scenario.route) || scenario.status !== 200) return [];
  const stats = '[data-testid="profile-stats"]';
  if (unavailable) return [{ selector: stats, count: 0 }];
  const other = scenario.path === "/members/100000000000000102";
  return [
    { selector: stats },
    { selector: `${stats} h2`, text: "Member stats" },
    { selector: `${stats} [data-testid="profile-rank"]`, text: other ? "Prospect" : "Veteran" },
    { selector: `${stats} dl`, includes: other ? "1 day" : "637 days" },
    { selector: `${stats} dl`, includes: other ? "Former member" : "Current member" },
    { selector: `${stats} [data-testid="profile-joined"] time`, attributes: { datetime: other ? "2026-09-30T00:00:00.000Z" : "2025-01-01T00:00:00.000Z" } },
    { selector: `${stats} ol > li`, count: other ? 0 : 2 },
    ...(other ? [{ selector: `${stats} p`, text: "No milestones yet." }] : [
      { selector: `${stats} ol > li:first-child`, includes: "Synthetic chess night — مرحباً" },
      { selector: `${stats} ol > li:first-child time`, attributes: { datetime: "2026-09-29T19:00:00.000Z" } },
    ]),
  ];
}

export async function assertAuditContent(page, scenario) {
  const expectations = contentExpectations(scenario);
  for (const expectation of expectations) {
    const locator = page.locator(expectation.selector);
    const count = expectation.count ?? 1;
    assert.equal(await locator.count(), count, `Fixture content count: ${expectation.selector}`);
    // An intentionally empty fallback <dd> has no box; its rank card must still be visible.
    if (expectation.text !== "") for (let i = 0; i < count; i++) assert(await locator.nth(i).isVisible(), `Fixture content hidden: ${expectation.selector}`);
    if (expectation.text !== undefined || expectation.includes !== undefined) {
      const text = (await locator.textContent()).replace(/\s+/g, " ").trim();
      if (expectation.text !== undefined) assert.equal(text, expectation.text, `Fixture content text: ${expectation.selector}`);
      if (expectation.includes !== undefined) assert(text.includes(expectation.includes), `Fixture content missing ${expectation.includes}: ${expectation.selector}`);
    }
    for (const [name, value] of Object.entries(expectation.attributes || {})) assert.equal(await locator.getAttribute(name), value, `Fixture content attribute: ${expectation.selector} ${name}`);
  }
  return expectations;
}
