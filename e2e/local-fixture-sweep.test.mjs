import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_FIXTURE_ORIGIN,
  LOCAL_FIXTURE_TITLE_PREFIXES,
  localSweepListPath,
  localSweepNextListPath,
  parseLocalFixtureRows,
  sweepLocalFixtures,
} from "./local-fixture-sweep.mjs";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const row = (key, title) => `<a href="/admin/events/${key}">${title}</a>`;
const response = (status, html = "") => ({ status: () => status, text: async () => html });

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
    row("01ARZ3NDEKTSV4RRFFQ69G5FAX", "E2E Waitlistish unrelated"),
    row("01ARZ3NDEKTSV4RRFFQ69G5FAY", "Staging E2E event"),
  ].join("");
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Waitlist "), [
    { eventKey: KEY, title: "E2E Waitlist fixture" },
  ]);
  assert.deepEqual(parseLocalFixtureRows(html, "E2E Promotion "), [
    { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW", title: "E2E Promotion fixture" },
  ]);
  assert.throws(() => localSweepListPath("Staging E2E ", "draft"), /invalid list filter/);
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
