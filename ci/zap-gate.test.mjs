import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, summarize } from "./zap-gate.mjs";

const report = (alerts) => ({ site: [{ alerts }] });
const alert = (pluginid, riskcode, name = `alert ${pluginid}`) => ({
  pluginid,
  riskcode,
  name,
  count: "2",
});

test("any High alert fails, even with no budgets set", () => {
  const r = summarize(report([alert(10062, "3")]), { maxMedium: null, maxLow: null });
  assert.equal(r.counts[3], 1);
  assert.equal(r.failures.length, 1);
});

test("null budgets report Medium/Low without failing", () => {
  const r = summarize(report([alert(10020, "2"), alert(10021, "1")]), {
    maxMedium: null,
    maxLow: null,
  });
  assert.deepEqual(r.failures, []);
});

test("counts above a set budget fail; at or below pass", () => {
  const alerts = [alert(1, "2"), alert(2, "2"), alert(3, "1")];
  assert.equal(summarize(report(alerts), { maxMedium: 1, maxLow: 1 }).failures.length, 1);
  assert.deepEqual(summarize(report(alerts), { maxMedium: 2, maxLow: 1 }).failures, []);
});

test("ignored plugin ids are excluded, including a High", () => {
  const r = summarize(report([alert(10062, "3")]), { ignore: [{ pluginId: 10062, why: "test" }] });
  assert.deepEqual(r.failures, []);
  assert.equal(r.alerts.length, 0);
});

test("the summary never prints URLs or evidence", () => {
  const withInstances = {
    ...alert(10020, "2"),
    instances: [{ uri: "https://example.invalid/secret?token=x", evidence: "leak" }],
  };
  const md = markdown(summarize(report([withInstances]), {}));
  assert.ok(!md.includes("example.invalid"));
  assert.ok(!md.includes("leak"));
  assert.match(md, /Medium/);
});
