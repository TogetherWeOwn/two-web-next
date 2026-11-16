// This adapter derives selector identities only after the existing receipt
// verifier accepts the report. It does not establish CI provenance or coverage.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { checkExecuted } from "./a11y-require-executed.mjs";
import { stableId } from "./execution-receipt-authority.mjs";

export const ROUTE_VITEST_IDENTITY_VERSION = 1;

export function routeVitestIdentities(report, suite, minimum, checkoutRoot) {
  checkExecuted(report, suite, minimum);
  if (typeof checkoutRoot !== "string" || !isAbsolute(checkoutRoot))
    throw new Error("route identity refused: invalid checkout root");
  const root = realpathSync(checkoutRoot);
  const files = new Set();
  const ids = new Set();
  const cases = [];
  for (const file of report.testResults) {
    if (!isAbsolute(file.name) || resolve(file.name) !== file.name)
      throw new Error("route identity refused: noncanonical file");
    const actual = realpathSync(file.name);
    const path = relative(root, actual);
    if (
      actual !== file.name ||
      !path ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path)
    )
      throw new Error("route identity refused: file outside checkout or aliased");
    if (files.has(path)) throw new Error("route identity refused: duplicate file");
    files.add(path);
    for (const entry of file.assertionResults) {
      if (!entry.ancestorTitles.includes(suite)) continue;
      const selector = {
        file: path.split(sep).join("/"),
        ancestors: entry.ancestorTitles,
        title: entry.title,
      };
      const id = stableId("route-vitest-v1", [JSON.stringify(selector)]);
      if (ids.has(id)) throw new Error("route identity refused: duplicate case");
      ids.add(id);
      cases.push({ selector, id });
    }
  }
  return { version: ROUTE_VITEST_IDENTITY_VERSION, cases };
}
