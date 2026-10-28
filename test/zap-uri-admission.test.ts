import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { summarize } from "../ci/zap-gate.mjs";

const origin = "https://scan.example.invalid";
const edge = `${origin}/cdn-cgi/main.js`;
const budget = {
  maxMedium: 0,
  maxLow: 0,
  ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "synthetic edge fixture" }],
};
function result(uri: string, name = origin) {
  return summarize(
    {
      site: [
        {
          "@name": name,
          alerts: [{ pluginid: "10096", riskcode: "1", count: "1", instances: [{ uri }] }],
        },
      ],
    },
    budget,
  );
}

describe("ZAP URI admission does not repair scope evidence", () => {
  it.each([
    ` ${edge}`,
    `${edge}\n`,
    `${edge}\u0000`,
    `${edge}\u007f`,
    `${origin}/cdn-cgi/main file.js`,
    "https:////scan.example.invalid/cdn-cgi/main.js",
    "https://scan.example.invalid\\cdn-cgi/main.js",
    `${origin}/cdn-cgi/%zz`,
    "https://user:password@scan.example.invalid/cdn-cgi/main.js",
  ])("retains a repaired, invalid or credential-bearing URI: %j", (uri) => {
    expect(result(uri).counts[1]).toBe(1);
    expect(result(edge, uri).counts[1]).toBe(1);
  });

  it.each(["HTTPS://SCAN.EXAMPLE.INVALID:443/cdn-cgi/main.js", `${origin}/cdn-cgi/main%20file.js`])(
    "allows valid parsed same-origin evidence: %s",
    (uri) => {
      expect(result(uri).failures).toEqual([]);
      expect(result(uri).alerts).toEqual([]);
    },
  );
});
