import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { markdown, summarize } from "../ci/zap-gate.mjs";

const report = (alerts: object[]) => ({ site: [{ alerts }] });
const alert = (pluginid: number, riskcode: string, name = `alert ${pluginid}`) => ({
  pluginid,
  riskcode,
  name,
  count: "2",
});

describe("ci/zap-gate.mjs", () => {
  it("fails on any High alert, even with no budgets set", () => {
    const r = summarize(report([alert(10062, "3")]), { maxMedium: null, maxLow: null });
    expect(r.counts[3]).toBe(1);
    expect(r.failures).toHaveLength(1);
  });

  it("reports Medium/Low without failing while budgets are null", () => {
    const r = summarize(report([alert(10020, "2"), alert(10021, "1")]), {
      maxMedium: null,
      maxLow: null,
    });
    expect(r.failures).toEqual([]);
  });

  it("fails above a set budget and passes at or below it", () => {
    const alerts = [alert(1, "2"), alert(2, "2"), alert(3, "1")];
    expect(summarize(report(alerts), { maxMedium: 1, maxLow: 1 }).failures).toHaveLength(1);
    expect(summarize(report(alerts), { maxMedium: 2, maxLow: 1 }).failures).toEqual([]);
  });

  it("excludes ignored plugin ids, including a High", () => {
    const r = summarize(report([alert(10062, "3")]), {
      ignore: [{ pluginId: 10062, why: "test" }],
    });
    expect(r.failures).toEqual([]);
    expect(r.alerts).toHaveLength(0);
  });

  it("scopes an ignore with uriPrefix to matching instances only", () => {
    const scoped = {
      ...alert(10096, "1", "Timestamp Disclosure"),
      instances: [
        {
          uri: "https://next.togetherweown.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js",
        },
        { uri: "https://next.togetherweown.com/" },
      ],
    };
    const budget = {
      maxMedium: 4,
      maxLow: 2,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const r = summarize(report([scoped]), budget);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].count).toBe(1);
    // The surviving Worker-served hit still counts against the Low budget.
    expect(summarize(report([scoped]), { ...budget, maxLow: 0 }).failures).toHaveLength(1);
  });

  it("drops a scoped ignore only when every instance matches", () => {
    const edgeOnly = {
      ...alert(10096, "1", "Timestamp Disclosure"),
      instances: [
        {
          uri: "https://next.togetherweown.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js",
        },
      ],
    };
    const budget = {
      maxMedium: 4,
      maxLow: 2,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const r = summarize(report([edgeOnly]), budget);
    expect(r.alerts).toHaveLength(0);
    expect(r.failures).toEqual([]);
  });

  it("keeps a scoped alert without instances, since scope cannot be proven", () => {
    const budget = {
      maxMedium: 4,
      maxLow: 0,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const r = summarize(report([alert(10096, "1")]), budget);
    expect(r.alerts).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  it("never prints URLs or evidence in the summary", () => {
    const withInstances = {
      ...alert(10020, "2"),
      instances: [{ uri: "https://example.invalid/secret?token=x", evidence: "leak" }],
    };
    const md = markdown(summarize(report([withInstances]), {}));
    expect(md).not.toContain("example.invalid");
    expect(md).not.toContain("leak");
    expect(md).toMatch(/Medium/);
  });
});
