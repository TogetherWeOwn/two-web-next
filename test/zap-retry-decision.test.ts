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
    const verdict = summarize(report([alert(10062, "3", "PII Disclosure")]), nullBudget);
    expect(isRetryablePiiFlake(verdict)).toBe(true);
  });

  it("rejects retry when any other High is present", () => {
    const verdict = summarize(
      report([alert(10062, "3", "PII Disclosure"), alert(40012, "3", "XSS")]),
      nullBudget,
    );
    expect(isRetryablePiiFlake(verdict)).toBe(false);
  });

  it("rejects retry for a lone non-PII High", () => {
    const verdict = summarize(report([alert(40012, "3", "Cross Site Scripting")]), nullBudget);
    expect(isRetryablePiiFlake(verdict)).toBe(false);
  });

  it("rejects retry when a lone PII High sits next to invalid evidence", () => {
    const verdict = summarize(report([alert(10062, "3", "PII Disclosure"), {}]), nullBudget);
    expect(isRetryablePiiFlake(verdict)).toBe(false);
  });

  it("rejects retry when Medium or Low are over budget", () => {
    const verdict = summarize(report([alert(10062, "3", "PII Disclosure"), alert(10021, "1")]), {
      maxMedium: null,
      maxLow: 0,
    });
    expect(isRetryablePiiFlake(verdict)).toBe(false);
  });

  it("rejects retry on a clean PASS", () => {
    const verdict = summarize({ site: [] }, nullBudget);
    expect(isRetryablePiiFlake(verdict)).toBe(false);
  });

  it.each([
    { counts: { 0: 0, 1: 0, 2: 0, 3: 2 } },
    { counts: [] },
    { site_count: -1 },
    { site_count: 0 },
    { site_count: 1001 },
    { site_count: "1" },
    { site_count: 9007199254740992 },
    { evidence_complete: false },
    { errors_truncated: true },
  ])("rejects inconsistent optional completeness metadata: %j", (metadata) => {
    const verdict = summarize(report([alert(10062, "3")]), nullBudget);
    expect(isRetryablePiiFlake({ ...verdict, ...metadata })).toBe(false);
  });

  it("never accepts even legitimate Markdown as retry authority", () => {
    const verdict = summarize(report([alert(10062, "3")]), nullBudget);
    expect(isRetryablePiiFlake(markdown(verdict))).toBe(false);
  });
});
