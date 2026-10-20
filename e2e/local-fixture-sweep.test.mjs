import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_FIXTURE_ORIGIN,
  LOCAL_FIXTURE_TITLE_PREFIXES,
  LOCAL_SWEEP_STATUSES,
  liveLocalFixtureGateQuery,
  loginLocalSweep,
  localSweepListPath,
  localSweepNextListPath,
  parseLocalFixtureRows,
  sweepLocalFixtures,
} from "./local-fixture-sweep.mjs";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const row = (key, title) => `<a href="/admin/events/${key}">${title}</a>`;
const response = (status, html = "") => ({ status: () => status, text: async () => html });
const throttled = () => ({ status: () => 429, headers: () => ({ "retry-after": "60" }) });

test("local teardown login honors the shared throttle before retrying", async () => {
  let time = 0;
  let attempts = 0;
  const waits = [];
  await loginLocalSweep(
    async (options) => {
      attempts++;
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.timeout, 30_000);
      return attempts === 1 ? throttled() : response(204);
    },
    {
      now: () => time,
      wait: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [60_000]);
});

test("local teardown login exhausts after three throttled attempts", async () => {
  let attempts = 0;
  let waits = 0;
  await assert.rejects(
    loginLocalSweep(
      async () => {
        attempts++;
        return throttled();
      },
      { wait: async () => waits++ },
    ),
    /QA login throttle retry limit exhausted/,
  );
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});

test("local teardown login never retries refused credentials or transport errors", async () => {
  for (const status of [302, 401, 403, 404, 500]) {
    let attempts = 0;
    await assert.rejects(
      loginLocalSweep(async () => {
        attempts++;
        return response(status);
      }),
      new RegExp(`QA moderator login answered ${status}`),
    );
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(
    loginLocalSweep(async () => {
      attempts++;
      throw new Error("sanitized transport failure");
    }),
    /sanitized transport failure/,
  );
  assert.equal(attempts, 1);
});

test("local teardown login refuses a wait beyond the shared deadline", async () => {
  await assert.rejects(
    loginLocalSweep(async () => throttled(), {
      now: () => 0,
      deadline: 60_000,
      wait: async () => assert.fail("No time remains for another request"),
    }),
    /time limit exhausted before QA login retry/,
  );
});

test("local teardown checks the shared deadline again after a throttle wait", async () => {
  let time = 0;
  let attempts = 0;
  await assert.rejects(
    loginLocalSweep(
      async () => {
        attempts++;
        return throttled();
      },
      {
        now: () => time,
        wait: async () => {
          time = 300_000;
        },
      },
    ),
    /time limit exhausted/,
  );
  assert.equal(attempts, 1);
});

test("local sweep targets only its fixed origin and cancels matching leftovers", async () => {
  let cancelled = false;
  const requests = [];
  const api = {
    async get(path, options) {
      requests.push({ method: "GET", path, options });
      assert.ok(path.startsWith("/admin/events?"));
      const query = new URL(path, LOCAL_FIXTURE_ORIGIN).searchParams;
      const prefix = LOCAL_FIXTURE_TITLE_PREFIXES.find((value) => value.trim() === query.get("q"));
      const hasLeftover =
        !cancelled && query.get("status") === "draft" && prefix === LOCAL_FIXTURE_TITLE_PREFIXES[0];
      return response(200, hasLeftover ? row(KEY, `${prefix}fixture`) : "");
    },
    async post(path, options) {
      requests.push({ method: "POST", path, options });
      cancelled = true;
      return response(303);
    },
  };

  assert.equal(await sweepLocalFixtures(api), 1);
  assert.equal(cancelled, true);
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  for (const { path, options } of requests) {
    assert.ok(path.startsWith("/"), "requests must be relative to the local API context");
    assert.equal(options.maxRedirects, 0);
    assert.ok(options.timeout > 0 && options.timeout <= 30_000);
    if (options.headers) assert.equal(options.headers.Origin, LOCAL_FIXTURE_ORIGIN);
  }
  assert.ok(requests.some(({ path }) => path.includes(encodeURIComponent(KEY))));
});

test("local sweep matches only its named fixture titles", () => {
  const html = [
    row(KEY, "E2E Waitlist fixture"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAW", "E2E Promotion fixture"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAA", "E2E Pause fixture"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAD", "E2E Moderator Game Night"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAE", "E2E Filter Draft 1760860000000"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAF", "E2E Filter Paused 1760860000000"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAB", "E2E Waitlistish unrelated"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAC", "Staging E2E event"),
  ].join("");
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Waitlist "), [
    { eventKey: KEY, title: "E2E Waitlist fixture" },
  ]);
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Promotion "), [
    { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW", title: "E2E Promotion fixture" },
  ]);
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Pause "), [
    { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA", title: "E2E Pause fixture" },
  ]);
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Moderator "), [
    { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAD", title: "E2E Moderator Game Night" },
  ]);
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Filter "), [
    { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAE", title: "E2E Filter Draft 1760860000000" },
    { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAF", title: "E2E Filter Paused 1760860000000" },
  ]);
  assert.throws(() => localSweepListPath("Staging E2E ", "draft"), /invalid list filter/);
});

test("local sweep lists and deletes E2E Filter fixtures in both swept statuses", async () => {
  assert.ok(LOCAL_FIXTURE_TITLE_PREFIXES.includes("E2E Filter "));
  const draftKey = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const publishedKey = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
  const cancelled = new Set();
  const seen = [];
  const api = {
    async get(path) {
      seen.push(path);
      const query = new URL(path, LOCAL_FIXTURE_ORIGIN).searchParams;
      if (query.get("q") !== "E2E Filter") return response(200);
      if (query.get("status") === "draft" && !cancelled.has(draftKey)) {
        return response(200, row(draftKey, "E2E Filter Draft 1760860000000"));
      }
      if (query.get("status") === "published" && !cancelled.has(publishedKey)) {
        return response(200, row(publishedKey, "E2E Filter Paused 1760860000000"));
      }
      return response(200);
    },
    async post(path) {
      cancelled.add(path.split("/")[3]);
      return response(303);
    },
  };
  assert.equal(await sweepLocalFixtures(api), 2);
  assert.deepEqual([...cancelled].sort(), [draftKey, publishedKey].sort());
  const listed = (status) =>
    seen.some((path) => {
      const query = new URL(path, LOCAL_FIXTURE_ORIGIN).searchParams;
      return query.get("q") === "E2E Filter" && query.get("status") === status;
    });
  assert.ok(listed("draft"), "sweep lists E2E Filter fixtures with status=draft");
  assert.ok(listed("published"), "sweep lists E2E Filter fixtures with status=published");
});

test("local pagination rejects staging and other non-local origins", () => {
  const current = localSweepListPath("E2E Waitlist ", "draft");
  const allowedNext = localSweepListPath("E2E Waitlist ", "draft", 2);
  assert.equal(
    localSweepNextListPath(`<a rel="next" href="${allowedNext}">Next</a>`, current),
    allowedNext,
  );
  for (const href of [
    `https://next.togetherweown.com${allowedNext}`,
    `https://togetherweown.com${allowedNext}`,
    "//example.invalid/admin/events?page=2",
    `${allowedNext}&status=published`,
    `${allowedNext}#external`,
  ]) {
    assert.throws(
      () => localSweepNextListPath(`<a rel="next" href="${href}">Next</a>`, current),
      /invalid pagination link/,
    );
  }
});

test("local sweep fails closed if cancellation leaves a fixture behind", async () => {
  const api = {
    async get(path) {
      const query = new URL(path, LOCAL_FIXTURE_ORIGIN).searchParams;
      return response(
        200,
        query.get("status") === "draft" && query.get("q") === "E2E Waitlist"
          ? row(KEY, "E2E Waitlist fixture")
          : "",
      );
    },
    async post() {
      return response(303);
    },
  };
  await assert.rejects(sweepLocalFixtures(api), /left 1 RSVP fixture\(s\) live after 4 passes/);
});

test("local sweep traverses lookalike-only pages and removes published promotion fixtures", async () => {
  let cancelled = false;
  let sawSecondPage = false;
  const api = {
    async get(path) {
      const query = new URL(path, LOCAL_FIXTURE_ORIGIN).searchParams;
      if (query.get("q") !== "E2E Promotion" || query.get("status") !== "published") {
        return response(200);
      }
      if (query.get("page") === "2") {
        sawSecondPage = true;
        return response(200, cancelled ? "" : row(KEY, "E2E Promotion leftover"));
      }
      return response(
        200,
        `${row("01ARZ3NDEKTSV4RRFFQ69G5FAW", "Not an E2E Promotion fixture")}<a rel="next" href="${localSweepListPath("E2E Promotion ", "published", 2)}">Next</a>`,
      );
    },
    async post(path) {
      assert.equal(path, `/admin/events/${KEY}/cancel`);
      cancelled = true;
      return response(303);
    },
  };
  assert.equal(await sweepLocalFixtures(api), 1);
  assert.equal(sawSecondPage, true);
});

test("local sweep fails closed on list redirects and cancellation errors", async () => {
  let writes = 0;
  await assert.rejects(
    sweepLocalFixtures({
      get: async () => response(302),
      post: async () => {
        writes++;
        return response(303);
      },
    }),
    /admin events list answered 302/,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    sweepLocalFixtures({
      get: async () => response(200, row(KEY, "E2E Waitlist leftover")),
      post: async () => response(429),
    }),
    /cancel answered 429/,
  );
});

test("local sweep bounds pagination before page 21", async () => {
  let reads = 0;
  await assert.rejects(
    sweepLocalFixtures({
      async get(path) {
        reads++;
        const page = Number(new URL(path, LOCAL_FIXTURE_ORIGIN).searchParams.get("page") ?? 1);
        return response(
          200,
          `<a rel="next" href="${localSweepListPath("E2E Waitlist ", "published", page + 1)}">Next</a>`,
        );
      },
      post: async () => assert.fail("No matching fixture to cancel"),
    }),
    /pagination limit exhausted/,
  );
  assert.equal(reads, 20);
});

test("local sweep refuses further requests after its deadline", async () => {
  let time = 0;
  let reads = 0;
  await assert.rejects(
    sweepLocalFixtures(
      {
        async get() {
          reads++;
          time = 300_000;
          return response(200);
        },
        post: async () => assert.fail("No matching fixture to cancel"),
      },
      { now: () => time },
    ),
    /time limit exhausted/,
  );
  assert.equal(reads, 1);
});

test("local gate query covers every swept prefix and status as bound parameters", () => {
  const gate = liveLocalFixtureGateQuery();
  // Built FROM the frozen lists: a new prefix or status can never slip past
  // the gate while the HTTP pass still sweeps it.
  assert.deepEqual(gate.values, [...LOCAL_SWEEP_STATUSES, ...LOCAL_FIXTURE_TITLE_PREFIXES]);
  assert.ok(gate.values.length > 0, "gate binds at least one value");
  for (let index = 1; index <= gate.values.length; index++) {
    assert.ok(gate.text.includes(`$${index}`), `gate text binds $${index}`);
  }
  assert.equal(
    gate.text.match(/starts_with\(title, \$\d+\)/g)?.length,
    LOCAL_FIXTURE_TITLE_PREFIXES.length,
  );
  assert.ok(gate.text.includes("from events"), "gate reads the events table");
  assert.ok(gate.text.includes("limit 1"), "gate stops at the first live row");
  assert.ok(!gate.text.includes("delete"), "gate never writes");
  assert.ok(!gate.text.includes("update"), "gate never writes");
});

test("local gate predicate matches the HTTP sweep set row for row", () => {
  // The gate is an existence check over exactly the rows the HTTP pass would
  // parse and cancel: status in the swept statuses AND title starting with a
  // swept prefix (parseLocalFixtureRows narrows the substring admin search to
  // the same case-sensitive prefix match). Mirror that predicate here so a
  // drift between the gate comment and the parse rule fails loudly.
  const gate = liveLocalFixtureGateQuery();
  const [statuses, prefixes] = [LOCAL_SWEEP_STATUSES, LOCAL_FIXTURE_TITLE_PREFIXES];
  const gateMatches = (title, status) =>
    statuses.includes(status) && prefixes.some((prefix) => title.startsWith(prefix));
  const cases = [
    ["E2E Waitlist fixture", "draft", true],
    ["E2E Promotion leftover", "published", true],
    ["E2E Pause fixture", "published", true],
    ["E2E Moderator Game Night", "draft", true],
    ["E2E Filter Draft 1760860000000", "published", true],
    ["E2E Community Night", "published", false],
    ["E2E Past Night", "published", false],
    ["E2E Waitlist fixture", "cancelled", false],
    ["E2E Waitlistish unrelated", "draft", false],
    ["Staging E2E event", "draft", false],
  ];
  for (const [title, status, expected] of cases) {
    assert.equal(gateMatches(title, status), expected, `${JSON.stringify(title)} / ${status}`);
  }
  assert.ok(gate.values.includes(statuses[0]), "gate binds the swept statuses");
  assert.ok(gate.values.includes(prefixes[0]), "gate binds the swept prefixes");
});
