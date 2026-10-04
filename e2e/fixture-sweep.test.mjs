// Backstop sweep for staging E2E event fixtures: list URL, row parsing and the
// leftover failure. Pure helpers only (no browser).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";
import * as sweepHelpers from "./fixture-sweep.mjs";
import {
  FIXTURE_TITLE_PREFIX,
  SWEEP_MAX_DURATION_MS,
  SWEEP_MAX_PAGES,
  SWEEP_MAX_PASSES,
  SWEEP_MAX_THROTTLE_RETRIES,
  SWEEP_STATUSES,
  leftoverFixturesError,
  parseFixtureRows,
  sweepListPath,
  sweepNextListPath,
} from "./fixture-sweep.mjs";
import { parseRetryAfterSeconds } from "./qa-login-retry.mjs";
import { sendTokenRequest } from "./qa-request.mjs";

// Low-entropy ULID-shaped keys: a real-looking key trips the secret scan.
const KEY_A = `${"0".repeat(25)}1`;
const KEY_B = `${"0".repeat(25)}2`;

function row(key, title) {
  return `<tr><td><a href="/admin/events/${key}">${title}</a></td><td>published</td></tr>`;
}

test("the sweep covers both statuses a cancel still applies to", () => {
  assert.deepEqual([...SWEEP_STATUSES], ["published", "draft"]);
  assert.ok(SWEEP_MAX_PASSES >= 1 && SWEEP_MAX_PASSES <= 6, "passes stay bounded");
});

test("the list URL filters by prefix and status, newest start first", () => {
  const url = new URL(sweepListPath("published"), "https://example.invalid");
  assert.equal(url.pathname, "/admin/events");
  assert.equal(url.searchParams.get("q"), "Staging E2E");
  assert.equal(url.searchParams.get("status"), "published");
  assert.equal(url.searchParams.get("sort"), "starts_at");
  assert.equal(url.searchParams.get("order"), "desc");
});

test("rows keep only fixture titles and carry their event key", () => {
  const html = [
    `<a href="/admin/events/new" data-testid="new-event">New event</a>`,
    row(KEY_A, `${FIXTURE_TITLE_PREFIX}RSVP 1791100000000`),
    // The list search is a substring match, so a lookalike can come back.
    row(KEY_B, "Not a Staging E2E fixture"),
  ].join("\n");
  assert.deepEqual(parseFixtureRows(html), [
    { eventKey: KEY_A, title: `${FIXTURE_TITLE_PREFIX}RSVP 1791100000000` },
  ]);
});

test("a page with no fixture rows parses to an empty list", () => {
  assert.deepEqual(parseFixtureRows(`<td data-testid="events-empty">No events</td>`), []);
  assert.deepEqual(parseFixtureRows(""), []);
});

test("keys that are not ULID-shaped never match", () => {
  const html = row("not-a-ulid", `${FIXTURE_TITLE_PREFIX}Draft 1`);
  assert.deepEqual(parseFixtureRows(html), []);
});

test("the leftover failure names every key and the way to clear them", () => {
  const error = leftoverFixturesError([KEY_A, KEY_B]);
  assert.match(error.message, /left 2 live/);
  assert.ok(error.message.includes(KEY_A) && error.message.includes(KEY_B));
  assert.match(error.message, /\/admin\/events/);
});

const ORIGIN = "https://example.invalid";
const source = transformSync(
  readFileSync(new URL("./staging/global-teardown.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs", target: "es2022" },
).code;

function response(status = 200, html = "") {
  return { status: () => status, text: async () => html, headers: () => ({ "retry-after": "60" }) };
}

function nextLink(status, page) {
  return `<a rel="next" href="${sweepListPath(status, page).replaceAll("&", "&amp;")}">Next</a>`;
}

// Execute the real teardown, not a copy of its algorithm. All I/O, login and
// runner seams are mocks; the parser, retry parser and request boundary are real.
function loadTeardown(api, { sleep = async () => {}, now = () => 0 } = {}) {
  const logs = [];
  let disposed = false;
  const module = { exports: {} };
  const mocks = {
    "@playwright/test": {
      request: {
        newContext: async () => ({
          get: (path, options) => {
            assert.equal(options.maxRedirects, 0);
            assert.ok(options.timeout > 0 && options.timeout <= 30_000);
            return api.get(path, options);
          },
          post: (path, options) => {
            assert.equal(options.maxRedirects, 0);
            assert.equal(options.headers.Origin, ORIGIN);
            assert.ok(options.timeout > 0 && options.timeout <= 30_000);
            return api.post(path, options);
          },
          dispose: async () => {
            disposed = true;
          },
        }),
      },
    },
    "../ci-only.mjs": { requireGithubRunner() {} },
    "../fixture-sweep.mjs": sweepHelpers,
    "../qa-login-retry.mjs": { parseRetryAfterSeconds, sleep },
    "../qa-request.mjs": { sendTokenRequest },
    "./fixtures": { moderatorStorageState: {}, stagingOrigin: ORIGIN },
    "./qa-login": { loginQaModerator: async () => {} },
  };
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      require: (name) => {
        assert.ok(name in mocks, `unexpected import ${name}`);
        return mocks[name];
      },
      Date: { now },
      console: { log: (...args) => logs.push(args.join(" ")) },
    },
    { filename: "global-teardown.ts" },
  );
  return { run: module.exports.default, logs, disposed: () => disposed };
}

for (const method of ["get", "post"]) {
  test(`teardown ${method} transport failure emits only a fresh reason`, async () => {
    const canary = "synthetic-session-cookie-canary";
    const original = new Error(
      [
        `apiRequestContext.${method}: socket hang up`,
        "Call log:",
        `  - cookie: fixture_session=${canary}`,
      ].join("\n"),
    );
    original.stack = `original-transport-stack\n${original.message}`;
    original.cause = new Error(`nested ${canary}`);
    const teardown = loadTeardown({
      get: async (path) => {
        if (method === "get") throw original;
        return response(
          200,
          path.includes("status=published") ? row(KEY_A, "Staging E2E RSVP 1") : "",
        );
      },
      post: async () => {
        throw original;
      },
    });
    await assert.rejects(teardown.run(), (error) => {
      assert.equal(error.cause, undefined);
      assert.match(error.message, /staging fixture sweep (list|cancel) failed: apiRequestContext/);
      const reportText = JSON.stringify({
        errors: Object.fromEntries(
          Object.getOwnPropertyNames(error).map((name) => [name, error[name]]),
        ),
        message: String(error),
        stdout: teardown.logs,
      });
      for (const rejected of [
        canary,
        "Call log",
        "cookie:",
        "original-transport-stack",
        "nested",
      ]) {
        assert.ok(!reportText.includes(rejected), `unexpected transport detail: ${rejected}`);
      }
      return true;
    });
    assert.ok(teardown.disposed());
  });
}

test("pagination preserves the origin, filters and one-page progress", () => {
  const current = sweepListPath("published");
  const expected = sweepListPath("published", 2);
  assert.equal(sweepNextListPath(nextLink("published", 2), current, ORIGIN), expected);
  assert.equal(
    sweepNextListPath(`<a href="${ORIGIN}${expected}" rel="next">Next</a>`, current, ORIGIN),
    expected,
  );
  assert.equal(sweepNextListPath("", current, ORIGIN), null);
  for (const href of [
    `https://foreign.invalid${expected}`,
    `//foreign.invalid${expected}`,
    `https://user:pass@example.invalid${expected}`,
    `/other${expected}`,
    `${expected}&status=draft`,
    `${expected}&extra=1`,
    `${expected}#fragment`,
    sweepListPath("draft", 2),
    sweepListPath("published", 3),
    current,
  ]) {
    assert.throws(
      () => sweepNextListPath(`<a rel="next" href="${href}">Next</a>`, current, ORIGIN),
      /invalid admin pagination/,
    );
  }
});

test("teardown crosses a rejected page and verifies every matching page after cancellation", async () => {
  let cancelled = false;
  const pages = [];
  const lookalikes = Array.from({ length: 25 }, (_, i) =>
    row(String(i + 2).padStart(26, "0"), "Not a staging e2e fixture"),
  ).join("");
  const teardown = loadTeardown({
    get: async (path) => {
      const url = new URL(path, ORIGIN);
      const status = url.searchParams.get("status");
      const page = Number(url.searchParams.get("page") ?? 1);
      pages.push(`${status}:${page}:${cancelled}`);
      if (status !== "published") return response();
      return response(
        200,
        page === 1
          ? lookalikes + nextLink("published", 2)
          : cancelled
            ? ""
            : row(KEY_A, "Staging E2E RSVP 1"),
      );
    },
    post: async (path) => {
      assert.equal(path, `/admin/events/${KEY_A}/cancel`);
      cancelled = true;
      return response(303);
    },
  });
  await teardown.run();
  assert.ok(cancelled);
  assert.deepEqual(pages, [
    "published:1:false",
    "published:2:false",
    "draft:1:false",
    "published:1:true",
    "published:2:true",
    "draft:1:true",
    "published:1:true",
    "published:2:true",
    "draft:1:true",
  ]);
  assert.ok(teardown.disposed());
});

test("a page-2 leftover in final verification fails the teardown", async () => {
  let lists = 0;
  const teardown = loadTeardown({
    get: async (path) => {
      const url = new URL(path, ORIGIN);
      if (url.searchParams.get("status") !== "published") return response();
      if (url.searchParams.get("page") === "2")
        return response(200, row(KEY_A, "Staging E2E RSVP 1"));
      lists++;
      return response(200, lists === 1 ? "" : nextLink("published", 2));
    },
    post: async () => assert.fail("no cancellation before final verification"),
  });
  await assert.rejects(teardown.run(), /left 1 live/);
  assert.ok(teardown.disposed());
});

test("admin pagination exhaustion fails rather than accepting an incomplete search", async () => {
  let lists = 0;
  const teardown = loadTeardown({
    get: async (path) => {
      lists++;
      const page = Number(new URL(path, ORIGIN).searchParams.get("page") ?? 1);
      return response(200, nextLink("published", page + 1));
    },
    post: async () => assert.fail("only lookalikes were listed"),
  });
  await assert.rejects(teardown.run(), /pagination limit exhausted/);
  assert.equal(lists, SWEEP_MAX_PAGES);
  assert.ok(teardown.disposed());
});

test("61 fixtures all cancel across the 30-write windows with fake waits", async () => {
  const live = new Set(Array.from({ length: 61 }, (_, i) => String(i + 1).padStart(26, "0")));
  let writes = 0;
  let cancelled = 0;
  let now = 0;
  const waits = [];
  const teardown = loadTeardown(
    {
      get: async (path) => {
        const url = new URL(path, ORIGIN);
        if (url.searchParams.get("status") !== "published") return response();
        const page = Number(url.searchParams.get("page") ?? 1);
        const start = (page - 1) * 25;
        const keys = [...live];
        const html = keys
          .slice(start, start + 25)
          .map((key) => row(key, "Staging E2E RSVP fixture"))
          .join("");
        return response(
          200,
          html + (keys.length > start + 25 ? nextLink("published", page + 1) : ""),
        );
      },
      post: async (path) => {
        if (writes >= 30) return response(429);
        writes++;
        cancelled++;
        assert.ok(live.delete(path.split("/")[3]));
        return response(303);
      },
    },
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
        writes = 0;
      },
    },
  );
  await teardown.run();
  assert.equal(cancelled, 61);
  assert.equal(live.size, 0);
  assert.deepEqual(waits, [60_000, 60_000]);
  assert.ok(teardown.disposed());
});

test("a final-pass throttle wait still retries the same cancellation", async () => {
  let posts = 0;
  let waits = 0;
  let cancelled = false;
  const teardown = loadTeardown(
    {
      get: async (path) =>
        response(
          200,
          path.includes("status=published") && !cancelled ? row(KEY_A, "Staging E2E RSVP 1") : "",
        ),
      post: async () => {
        posts++;
        if (posts < SWEEP_MAX_PASSES) return response(503);
        if (posts === SWEEP_MAX_PASSES) return response(429);
        cancelled = true;
        return response(303);
      },
    },
    {
      sleep: async () => {
        waits++;
      },
    },
  );
  await teardown.run();
  assert.equal(posts, SWEEP_MAX_PASSES + 1);
  assert.equal(waits, 1);
  assert.ok(cancelled);
});

test("terminal throttle retry exhaustion fails safely and disposes the context", async () => {
  let posts = 0;
  let waits = 0;
  const teardown = loadTeardown(
    {
      get: async (path) =>
        response(200, path.includes("status=published") ? row(KEY_A, "Staging E2E RSVP 1") : ""),
      post: async () => {
        posts++;
        return response(429);
      },
    },
    {
      sleep: async () => {
        waits++;
      },
    },
  );
  await assert.rejects(teardown.run(), /throttle retry limit exhausted/);
  assert.equal(posts, SWEEP_MAX_THROTTLE_RETRIES + 1);
  assert.equal(waits, SWEEP_MAX_THROTTLE_RETRIES);
  assert.ok(teardown.disposed());
});

test("the elapsed deadline refuses a wait that leaves no useful retry time", async () => {
  let now = 0;
  let waits = 0;
  const teardown = loadTeardown(
    {
      get: async (path) =>
        response(200, path.includes("status=published") ? row(KEY_A, "Staging E2E RSVP 1") : ""),
      post: async () => {
        now = SWEEP_MAX_DURATION_MS - 60_000;
        return response(429);
      },
    },
    {
      now: () => now,
      sleep: async () => {
        waits++;
      },
    },
  );
  await assert.rejects(teardown.run(), /time limit exhausted before throttle retry/);
  assert.equal(waits, 0);
  assert.ok(teardown.disposed());
});

test("an elapsed deadline after a wait stops before another authenticated request", async () => {
  let now = 0;
  let posts = 0;
  const teardown = loadTeardown(
    {
      get: async (path) =>
        response(200, path.includes("status=published") ? row(KEY_A, "Staging E2E RSVP 1") : ""),
      post: async () => {
        posts++;
        return response(429);
      },
    },
    {
      now: () => now,
      sleep: async () => {
        now = SWEEP_MAX_DURATION_MS;
      },
    },
  );
  await assert.rejects(teardown.run(), /time limit exhausted/);
  assert.equal(posts, 1);
  assert.ok(teardown.disposed());
});
