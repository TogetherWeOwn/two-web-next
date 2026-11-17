import { isDeepStrictEqual } from "node:util";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertNoDuplicateKeys } from "./a11y-require-executed.mjs";
import { routeVitestIdentities } from "./route-vitest-identities.mjs";

// This fixture is deliberately synthetic. It neither executes candidate tests
// nor admits a real route obligation.
const fixturePath = "ci/fixtures/execution-receipt-vitest.json";
const suite = "RSVP outcome focus in Chromium";

export function syntheticRouteReport(root) {
  const report = JSON.parse(readFileSync(join(root, fixturePath), "utf8"));
  report.testResults[0].name = fixturePath;
  return Buffer.from(JSON.stringify(report));
}

export function validateSyntheticRouteReport(root, entries) {
  try {
    if (!(entries instanceof Map) || entries.size !== 1 || !entries.has("report.json"))
      throw new Error("invalid entries");
    const bytes = entries.get("report.json");
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024)
      throw new Error("invalid report");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateKeys(raw);
    const report = JSON.parse(raw);
    const expected = JSON.parse(syntheticRouteReport(root).toString("utf8"));
    if (!isDeepStrictEqual(report, expected)) throw new Error("unexpected report");
    report.testResults[0].name = realpathSync(join(root, fixturePath));
    const identities = routeVitestIdentities(report, suite, 3, root);
    if (identities.cases.length !== 3) throw new Error("unexpected selectors");
    return identities;
  } catch {
    throw new Error("route evidence refused: invalid synthetic report");
  }
}
