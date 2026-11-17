import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { syntheticRouteReport } from "./route-evidence-synthetic-report.mjs";

// Run only from the reviewed workflow checkout, never from a candidate checkout.
// The report is a synthetic fixture, not evidence that candidate tests ran.
if (process.argv.length !== 3 || !process.argv[2]) {
  throw new Error("expected an output report path");
}
const report = syntheticRouteReport(process.cwd());
writeFileSync(process.argv[2], report, { flag: "wx" });
process.stdout.write(
  `synthetic report sha256:${createHash("sha256").update(report).digest("hex")}\n`,
);
