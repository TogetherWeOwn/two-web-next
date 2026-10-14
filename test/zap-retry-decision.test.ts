import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { isRetryablePiiFlake } from "../ci/zap-retry-decision.mjs";
// @ts-expect-error Standalone tooling has no declaration file.
import { markdown, summarize } from "../ci/zap-gate.mjs";

const report = (alerts: object[]) => ({ site: [{ alerts }] });
const alert = (pluginid: number, riskcode: string, name = `alert ${pluginid}`) => ({
  pluginid,
  riskcode,
  name,
  count: "2",
});
const nullBudget = { maxMedium: null, maxLow: null };

describe("ci/zap-retry-decision.mjs", () => {
  it("flags a lone PII Disclosure High as retryable", () => {
    const md = markdown(summarize(report([alert(10062, "3", "PII Disclosure")]), nullBudget));
    expect(isRetryablePiiFlake(md)).toBe(true);
  });

  it("rejects retry when any other High is present", () => {
    const md = markdown(
      summarize(
        report([alert(10062, "3", "PII Disclosure"), alert(40012, "3", "XSS")]),
        nullBudget,
      ),
    );
    expect(isRetryablePiiFlake(md)).toBe(false);
  });

  it("rejects retry when Medium or Low are over budget", () => {
    const md = markdown(
      summarize(report([alert(10062, "3", "PII Disclosure"), alert(10021, "1")]), {
        maxMedium: null,
        maxLow: 0,
      }),
    );
    expect(isRetryablePiiFlake(md)).toBe(false);
  });

  it("rejects retry on a clean PASS", () => {
    const md = markdown(summarize({ site: [] }, nullBudget));
    expect(isRetryablePiiFlake(md)).toBe(false);
  });
});
