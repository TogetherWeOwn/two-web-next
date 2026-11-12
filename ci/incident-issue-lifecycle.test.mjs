import assert from "node:assert/strict";
import { test } from "node:test";
import { syncIncident } from "./incident-issue-lifecycle.mjs";

const marker = (key) => `<!-- incident-key: ${key} -->`;
function fixture({ issues = [], label = false, intercept } = {}) {
  const calls = [];
  const state = { issues: structuredClone(issues), label };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const overridden = intercept?.(method, path, body, state);
    if (overridden !== undefined) return overridden;
    if (method === "GET" && path.startsWith("/issues?"))
      return state.issues.filter((issue) => issue.state !== "closed");
    if (method === "GET" && path === "/labels/incident") {
      if (!state.label) throw Object.assign(new Error("not found"), { status: 404 });
      return { name: "incident" };
    }
    if (method === "POST" && path === "/labels") {
      state.label = true;
      return {};
    }
    if (method === "POST" && path === "/issues") {
      const issue = { ...body, number: 100 + state.issues.length, state: "open" };
      state.issues.push(issue);
      return issue;
    }
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) return {};
    if (method === "PATCH" && /\/issues\/\d+$/.test(path)) {
      Object.assign(
        state.issues.find((issue) => issue.number === Number(path.split("/")[2])),
        body,
      );
      return {};
    }
    throw new Error(`Unexpected fixture call: ${method} ${path}`);
  };
  return { api, calls, state };
}
const sync = (f, extra = {}) =>
  syncIncident({
    api: f.api,
    key: "staging-quality",
    title: "staging-quality failed",
    body: "Run: fixture; threshold <=600; measured 660",
    ...extra,
  });
const keyed = (number, key = "staging-quality") => ({ number, body: marker(key), state: "open" });

test("first failure creates the label and one keyed incident; repeats comment", async () => {
  const f = fixture();
  await sync(f);
  assert.equal(f.state.label, true);
  assert.equal(f.state.issues.length, 1);
  assert.match(f.state.issues[0].body, /incident-key: staging-quality/);
  assert.deepEqual(f.state.issues[0].labels, ["incident"]);
  await sync(f);
  assert.equal(f.state.issues.length, 1);
  assert.match(
    f.calls.find((call) => call.path === "/issues/100/comments").body.body,
    /Still failing/,
  );
});

test("recovery closes all keyed duplicates and does not create an incident", async () => {
  const f = fixture({ issues: [keyed(2), keyed(1), keyed(3, "other")] });
  await sync(f, { recovered: true });
  assert.equal(f.state.issues[0].state, "closed");
  assert.equal(f.state.issues[1].state, "closed");
  assert.equal(f.state.issues[2].state, "open");
  assert.equal(f.calls.filter((call) => call.path.endsWith("/comments")).length, 2);
  assert.ok(
    f.calls
      .filter((call) => call.path.endsWith("/comments"))
      .every((call) => call.body.body.startsWith("Recovered.")),
  );
  const empty = fixture();
  await sync(empty, { recovered: true });
  assert.equal(empty.calls.filter((call) => call.method !== "GET").length, 0);
});

test("pagination reaches keyed issues and refuses incomplete or malformed searches", async () => {
  const f = fixture({
    intercept(method, path) {
      if (method !== "GET" || !path.startsWith("/issues?")) return;
      return path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => keyed(i + 1, "other"))
        : [keyed(150)];
    },
  });
  await sync(f);
  assert.ok(f.calls.some((call) => call.path === "/issues/150/comments"));
  const full = fixture({
    intercept(method, path) {
      if (method === "GET" && path.startsWith("/issues?"))
        return Array.from({ length: 100 }, (_, i) => keyed(i + 1, "other"));
    },
  });
  await assert.rejects(sync(full), /ten pages/);
  assert.equal(full.calls.length, 10);
  const malformed = fixture({ issues: [{ number: "bad" }] });
  await assert.rejects(sync(malformed), /Malformed/);
});

test("PR markers do not dedupe incidents; a concurrent create converges on lowest issue", async () => {
  const pr = fixture({ issues: [{ ...keyed(2), pull_request: {} }] });
  await sync(pr);
  assert.equal(pr.state.issues.length, 2);
  const f = fixture({
    intercept(method, path, _body, state) {
      if (method === "GET" && path.startsWith("/issues?") && state.issues.length === 1) {
        state.issues.push(keyed(1));
      }
    },
  });
  await sync(f);
  assert.equal(f.state.issues.find((issue) => issue.number === 100).state, "closed");
  assert.ok(f.calls.some((call) => call.path === "/issues/1/comments"));
});

test("label creation races recheck the label before creating an incident", async () => {
  const f = fixture({
    intercept(method, path, _body, state) {
      if (method === "POST" && path === "/labels") {
        state.label = true;
        throw Object.assign(new Error("already exists"), { status: 422 });
      }
    },
  });
  await sync(f);
  assert.equal(f.calls.filter((call) => call.path === "/labels/incident").length, 2);
  assert.equal(f.state.issues.length, 1);
});

test("malformed pages and creation responses fail closed", async () => {
  for (const result of [null, Array(101).fill(keyed(1)), [{ number: 1, body: {} }]]) {
    const f = fixture({
      intercept: (method, path) =>
        method === "GET" && path.startsWith("/issues?") ? result : undefined,
    });
    await assert.rejects(sync(f), /Malformed/);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture({
    intercept: (method, path) => (method === "POST" && path === "/issues" ? {} : undefined),
  });
  await assert.rejects(sync(f), /no issue number/);
});

test("sink failures propagate; invalid keys cannot reach the API", async () => {
  const f = fixture({
    intercept(method, path) {
      if (method === "POST" && path === "/issues") throw new Error("sink unavailable");
    },
  });
  await assert.rejects(sync(f), /sink unavailable/);
  const invalid = fixture();
  await assert.rejects(sync(invalid, { key: "bad\nkey" }), /Invalid incident key/);
  assert.equal(invalid.calls.length, 0);
});
