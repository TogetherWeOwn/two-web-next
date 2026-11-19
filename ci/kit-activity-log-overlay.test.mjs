import assert from "node:assert/strict";
import test from "node:test";
import { activityLogFixtureSource } from "./kit-activity-log-overlay.mjs";

const source = `
const ROUTE_MANIFEST = [
  { method: "GET", path: "/admin/activity-log", enabled: false, reads: "activity_log" },
  { method: "GET", path: "/admin/events", enabled: false },
];
return (event, deps) => {
  const route = decideRoute(
    event.request,
    deps.manifest ??
      ROUTE_MANIFEST,
  );
  return route;
};`;

test("activity-log overlay admits only exact loopback GET and preserves declared reads", () => {
  const choose = new Function("decideRoute", activityLogFixtureSource(source))(
    (_, manifest) => manifest,
  );
  const origin = "http://127.0.0.1:8788";
  const path = "/admin/activity-log";
  const resolve = (url, method = "GET", appUrl = origin) =>
    choose({ request: new Request(url, { method }) }, { appUrl });
  const [activity, events] = resolve(`${origin}${path}?page=2`);
  assert.deepEqual(activity, { method: "GET", path, enabled: true, reads: "activity_log" });
  assert.equal(events.enabled, false);
  for (const args of [
    [`${origin}${path}`, "POST"],
    [`${origin}${path}`, "HEAD"],
    [`${origin}${path}/`],
    [`${origin}${path}/__data.json`],
    [`${origin}/admin/events`],
    [`http://localhost:8788${path}`],
    [`${origin}${path}`, "GET", "https://example.invalid"],
  ]) {
    assert.equal(resolve(...args)[0].enabled, false);
  }
});

test("activity-log overlay refuses absent or ambiguous dispatcher anchors", () => {
  for (const candidate of ["", source + source]) {
    assert.throws(() => activityLogFixtureSource(candidate), /Pinned dispatcher shape changed/);
  }
});
