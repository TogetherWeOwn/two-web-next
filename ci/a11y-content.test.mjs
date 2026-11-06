import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAuditContent, contentExpectations } from "./a11y-content.mjs";
import { coverage } from "./a11y-cases.mjs";

function fixturePage(scenario, changed = {}) {
  const expected = contentExpectations(scenario);
  return {
    locator(selector) {
      const entries = expected.filter((entry) => entry.selector === selector);
      const entry = Object.assign({}, ...entries, changed[selector]);
      return {
        count: async () => entry.count ?? 1,
        nth: () => ({ isVisible: async () => entry.visible ?? true }),
        textContent: async () => entry.text ?? entries.map((item) => item.includes || "").join(" "),
        getAttribute: async (name) => entry.attributes?.[name],
      };
    },
  };
}
const home = { route: "/", path: "/", status: 200 };
const owner = { route: "/profile", path: "/profile", status: 200 };

for (const identity of ["guest", "member", "moderator"]) {
  test(`event content requires the ${identity} visibility state before axe`, async () => {
    const scenario = { route: "/e/:key", status: 200, identity, state: "going" };
    const attendees = identity === "member" ? 1 : 0;
    const pitch = identity === "guest" ? 1 : 0;
    const expectations = contentExpectations(scenario);
    assert.equal(
      expectations.find((item) => item.selector === '[data-testid="event-attendees"]').count,
      attendees,
    );
    assert.equal(
      expectations.find((item) => item.selector === '[data-testid="event-join-pitch"]').count,
      pitch,
    );
    await assertAuditContent(fixturePage(scenario), scenario);
    for (const [selector, expected] of [
      ['[data-testid="event-attendees"]', attendees],
      ['[data-testid="event-join-pitch"]', pitch],
    ]) {
      await assert.rejects(
        assertAuditContent(
          fixturePage(scenario, { [selector]: { count: 1 - expected } }),
          scenario,
        ),
        /Fixture content count/,
      );
    }
  });
}

test("published review retains the seeded member attendees before axe", async () => {
  const scenario = {
    route: "/e/:key",
    status: 200,
    identity: "moderator",
    state: "review-published",
  };
  const selector = '[data-testid="event-attendees"]';
  assert.equal(contentExpectations(scenario).find((item) => item.selector === selector).count, 1);
  await assertAuditContent(fixturePage(scenario), scenario);
  for (const count of [0, 2])
    await assert.rejects(
      assertAuditContent(fixturePage(scenario, { [selector]: { count } }), scenario),
      /Fixture content count/,
    );
});

test("saved-draft audit requires the saved notice and its review link before axe", async () => {
  const route = "/admin/events/:key";
  const scenario = coverage[route].cases.find((item) => item.state === "saved-draft");
  assert.equal(scenario.path, "/admin/events/01J00000000000000000000017?saved=1");
  const page = { ...scenario, route, status: 200 };
  const notice = '[data-testid="event-saved-review"]';
  const link = `${notice} a[href="/e/01J00000000000000000000017?review=1"]`;
  const expectations = await assertAuditContent(fixturePage(page), page);
  assert(expectations.some((item) => item.selector === link));
  await assert.rejects(
    assertAuditContent(fixturePage(page, { [notice]: { count: 0 } }), page),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(fixturePage(page, { [link]: { count: 0 } }), page),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(fixturePage(page, { [notice]: { attributes: { role: "alert" } } }), page),
    /Fixture content attribute/,
  );
  // The plain edit page is audited too and must not carry the saved notice.
  const plain = coverage[route].cases.find((item) => !item.state && !item.status);
  const plainPage = { ...plain, route, status: 200 };
  assert.deepEqual(contentExpectations(plainPage), [{ selector: notice, count: 0 }]);
  await assert.rejects(
    assertAuditContent(fixturePage(plainPage, { [notice]: { count: 1 } }), plainPage),
    /Fixture content count/,
  );
  assert.deepEqual(contentExpectations({ ...page, status: 404 }), []);
});

for (const [state, key, guidance] of [
  [
    "review-corrections",
    "01J00000000000000000000017",
    "This is a draft. Only moderators can see this page.",
  ],
  [
    "review-published",
    "01J00000000000000000000015",
    "This event is already published. This is what members see now.",
  ],
  ["review-cancelled", "01J00000000000000000000016", "This event is cancelled."],
]) {
  test(`${state} audit requires the review banner and an inert RSVP before axe`, async () => {
    const scenario = coverage["/e/:key"].cases.find((item) => item.state === state);
    assert.equal(scenario.path, `/e/${key}?review=1`);
    assert.equal(scenario.identity, "moderator");
    const page = { ...scenario, route: "/e/:key", status: 200 };
    const review = '[data-testid="event-review"]';
    const corrections = state === "review-corrections";
    const expectations = await assertAuditContent(fixturePage(page), page);
    const find = (selector) => expectations.find((item) => item.selector === selector);
    assert.equal(find(`${review} > p:nth-of-type(2)`).text, guidance);
    assert.equal(find(`${review} li`).count, corrections ? 1 : 0);
    assert.equal(find(review).attributes.role, corrections ? "alert" : "status");
    // Live RSVP controls must really be absent, and the placeholder disabled.
    for (const selector of [
      '[data-island="rsvp-button"]',
      "[data-rsvp-form]",
      'form[action*="/rsvp"]',
      'button[name="status"]',
    ]) {
      assert.equal(find(selector).count, 0);
      await assert.rejects(
        assertAuditContent(fixturePage(page, { [selector]: { count: 1 } }), page),
        /Fixture content count/,
      );
    }
    const placeholder = 'button[aria-describedby="preview-rsvp-hint"]';
    await assert.rejects(
      assertAuditContent(fixturePage(page, { [placeholder]: { attributes: {} } }), page),
      /Fixture content attribute/,
    );
    await assert.rejects(
      assertAuditContent(fixturePage(page, { "#preview-rsvp-hint": { count: 0 } }), page),
      /Fixture content count/,
    );
    await assert.rejects(
      assertAuditContent(fixturePage(page, { [review]: { count: 0 } }), page),
      /Fixture content count/,
    );
    await assert.rejects(
      assertAuditContent(
        fixturePage(page, { [`${review} li`]: { count: corrections ? 0 : 1 } }),
        page,
      ),
      /Fixture content count/,
    );
    if (corrections) {
      await assert.rejects(
        assertAuditContent(
          fixturePage(page, {
            [`${review} li a[href="/admin/events/${key}#f-location"]`]: { count: 0 },
          }),
          page,
        ),
        /Fixture content count/,
      );
    }
    if (state === "review-cancelled") {
      // The removed listing claim is false; it must fail the exact guidance.
      await assert.rejects(
        assertAuditContent(
          fixturePage(page, {
            [`${review} > p:nth-of-type(2)`]: {
              text: "This event is cancelled. Members don't see it in listings.",
            },
          }),
          page,
        ),
        /Fixture content text/,
      );
    }
  });
}

test("non-review event states carry no review expectations", () => {
  for (const item of coverage["/e/:key"].cases.filter((c) => !c.state?.startsWith("review-"))) {
    const page = { status: 200, identity: "guest", ...item, route: "/e/:key" };
    assert(
      contentExpectations(page).every((entry) => !entry.selector.includes("event-review")),
      `unexpected review expectation for ${item.path}`,
    );
  }
});

test("the waitlisted event fixture cannot silently render as going", async () => {
  const scenario = { route: "/e/:key", status: 200, identity: "member", state: "waitlisted" };
  await assertAuditContent(fixturePage(scenario), scenario);
  await assert.rejects(
    assertAuditContent(
      fixturePage(scenario, { ".event-hero h1": { attributes: { "data-waitlist-position": "" } } }),
      scenario,
    ),
    /Fixture content attribute/,
  );
  assert(
    coverage[scenario.route].cases.some(
      (item) => item.state === "going" && item.identity === "member",
    ),
  );
  assert(
    coverage[scenario.route].cases.some(
      (item) => item.state === "waitlisted" && item.identity === "member",
    ),
  );
  assert.deepEqual(contentExpectations({ ...scenario, status: 410 }), []);
});

test("paused-member audit requires the paused hold and no join control before axe", async () => {
  const scenario = coverage["/e/:key"].cases.find((item) => item.state === "paused-member");
  assert.equal(scenario.path, "/e/01J00000000000000000000020");
  assert.equal(scenario.identity, "member");
  const page = { ...scenario, route: "/e/:key", status: 200 };
  await assertAuditContent(fixturePage(page), page);
  await assert.rejects(
    assertAuditContent(fixturePage(page, { '[data-testid="rsvp-paused"]': { count: 0 } }), page),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(fixturePage(page, { '[data-testid="rsvp-going"]': { count: 1 } }), page),
    /Fixture content count/,
  );
});

test("cancelled-member audit requires the cancelled notice alone before axe", async () => {
  const scenario = coverage["/e/:key"].cases.find((item) => item.state === "cancelled-member");
  assert.equal(scenario.identity, "member");
  assert.equal(scenario.status, 410);
  const page = { ...scenario, route: "/e/:key" };
  await assertAuditContent(fixturePage(page), page);
  await assert.rejects(
    assertAuditContent(
      fixturePage(page, { '[data-testid="event-cancelled"]': { count: 0 } }),
      page,
    ),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(fixturePage(page, { '[data-island="rsvp-button"]': { count: 1 } }), page),
    /Fixture content count/,
  );
});

test("404 audit distinguishes populated suggestions from their empty fallback", async () => {
  const populated = { route: "/__a11y/404", status: 404 };
  const empty = { route: "/__a11y/404-empty", status: 404 };
  for (const scenario of [populated, empty])
    await assertAuditContent(fixturePage(scenario), scenario);
  const cards = '[data-testid="error-event-suggestions"] .card';
  assert.equal(contentExpectations(populated).find((item) => item.selector === cards).count, 3);
  for (const count of [0, 1, 2, 4])
    await assert.rejects(
      assertAuditContent(fixturePage(populated, { [cards]: { count } }), populated),
      /Fixture content count/,
    );
  for (const key of [
    "01J00000000000000000000015",
    "01J00000000000000000000019",
    "01J00000000000000000000020",
  ]) {
    const link = `${cards} > a[href="/e/${key}"]`;
    await assert.rejects(
      assertAuditContent(fixturePage(populated, { [link]: { count: 0 } }), populated),
      /Fixture content count/,
    );
    await assert.rejects(
      assertAuditContent(fixturePage(populated, { [link]: { text: "Wrong event" } }), populated),
      /Fixture content text/,
    );
  }
  await assert.rejects(
    assertAuditContent(fixturePage(empty, { [cards]: { count: 1 } }), empty),
    /Fixture content count/,
  );
  assert(coverage[populated.route].cases.some((item) => item.status === 404));
  assert(coverage[empty.route].cases.some((item) => item.status === 404));
});

test("past-page overflow must show the archive boundary, not an empty archive", async () => {
  const scenario = coverage["/events/past"].cases.find(
    (item) => item.state === "past-page-overflow",
  );
  assert.equal(scenario.path, "/events/past?page=99");
  const page = { ...scenario, route: "/events/past", status: 200 };
  await assertAuditContent(fixturePage(page), page);
  await assert.rejects(
    assertAuditContent(
      fixturePage(page, {
        '[data-testid="past-events"]': {
          attributes: { "data-page": "99", "data-total-pages": "0" },
        },
      }),
      page,
    ),
    /Fixture content attribute/,
  );
  await assert.rejects(
    assertAuditContent(
      fixturePage(page, { '[data-testid="past-events-out-of-range"]': { count: 0 } }),
      page,
    ),
    /Fixture content count/,
  );
});

test("navigated calendar month must render its chosen month and grid", async () => {
  const scenario = coverage["/events"].cases.find((item) => item.state === "navigated-month");
  assert.equal(scenario.path, "/events?view=calendar&month=2099-12");
  const page = { ...scenario, route: "/events", status: 200 };
  await assertAuditContent(fixturePage(page), page);
  await assert.rejects(
    assertAuditContent(
      fixturePage(page, { '[data-testid="calendar-month"]': { text: "November 2099" } }),
      page,
    ),
    /Fixture content text/,
  );
  await assert.rejects(
    assertAuditContent(
      fixturePage(page, { '[data-testid="events-calendar-grid"]': { count: 0 } }),
      page,
    ),
    /Fixture content count/,
  );
});

test("freeze and expired-write banners are present only in their audited states", async () => {
  const cases = coverage["/about"].cases;
  assert(cases.some((item) => item.path === "/about" && !item.state));
  for (const state of ["freeze-banner", "expired-write-banner", "both-banners"]) {
    const scenario = cases.find((item) => item.state === state);
    assert.equal(scenario.path, "/about");
    const page = { ...scenario, route: "/about", status: 200 };
    await assertAuditContent(fixturePage(page), page);
    for (const [selector, expected] of [
      ['[data-testid="freeze-banner"]', state === "expired-write-banner" ? 0 : 1],
      ['[data-testid="auth-error"]', state === "freeze-banner" ? 0 : 1],
    ]) {
      assert.equal(
        contentExpectations(page).find((item) => item.selector === selector).count,
        expected,
      );
      await assert.rejects(
        assertAuditContent(fixturePage(page, { [selector]: { count: 1 - expected } }), page),
        /Fixture content count/,
      );
    }
  }
});

test("home assertions require member, online, numeric and zero-rank content before axe", async () => {
  const assertions = await assertAuditContent(fixturePage(home), home);
  assert(assertions.some((item) => item.text === "84 members · 12 online"));
  assert(assertions.some((item) => item.text === "unclaimed"));
  await assert.rejects(
    assertAuditContent(fixturePage(home, { '[data-testid="member-count"]': { count: 0 } }), home),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(fixturePage(home, { '[data-rank="member"] dd': { text: "" } }), home),
    /Fixture content text/,
  );
});

test("fallback rank/joined text cannot substitute for populated profile stats", async () => {
  await assertAuditContent(fixturePage(owner), owner);
  await assert.rejects(
    assertAuditContent(
      fixturePage(owner, { '[data-testid="profile-stats"]': { count: 0 } }),
      owner,
    ),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(
      fixturePage(owner, { '[data-testid="profile-stats"] ol > li': { count: 0 } }),
      owner,
    ),
    /Fixture content count/,
  );
  await assert.rejects(
    assertAuditContent(
      fixturePage(owner, { '[data-testid="profile-stats"]': { visible: false } }),
      owner,
    ),
    /Fixture content hidden/,
  );
});

test("unavailable and populated states coexist; unavailable content must really be absent", async () => {
  for (const scenario of [home, owner]) {
    const unavailable = { ...scenario, readState: "unavailable" };
    const expectations = await assertAuditContent(fixturePage(unavailable), unavailable);
    const absent = expectations.find((item) => item.count === 0);
    await assert.rejects(
      assertAuditContent(
        fixturePage(unavailable, { [absent.selector]: { count: 1 } }),
        unavailable,
      ),
      /Fixture content count/,
    );
    assert(coverage[scenario.route].cases.some((item) => item.readState === "unavailable"));
    assert(coverage[scenario.route].cases.some((item) => !item.readState));
  }
});

test("empty fallback totals may have no box but their rank cards must remain visible", async () => {
  const unavailable = { ...home, readState: "unavailable" };
  await assertAuditContent(
    fixturePage(unavailable, { '[data-rank="prospect"] dd': { visible: false } }),
    unavailable,
  );
  await assert.rejects(
    assertAuditContent(
      fixturePage(unavailable, { '[data-testid="rank-stack"] > div': { visible: false } }),
      unavailable,
    ),
    /Fixture content hidden/,
  );
});

test("other-member empty milestones, validation errors and non-profile pages retain their cases", async () => {
  const other = { route: "/members/:user", path: "/members/100000000000000102", status: 200 };
  assert(contentExpectations(other).some((item) => item.text === "No milestones yet."));
  await assertAuditContent(fixturePage(other), other);
  assert.deepEqual(contentExpectations({ ...other, status: 404 }), []);
  assert.deepEqual(contentExpectations({ route: "/events", status: 200 }), []);
  assert.deepEqual(
    contentExpectations({ ...owner, state: "validation-error" }),
    contentExpectations(owner),
  );
});
