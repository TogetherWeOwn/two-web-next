import { readFileSync } from "node:fs";
import { relative } from "node:path";

const summary = JSON.parse(
  readFileSync(process.argv[2] ?? "coverage/coverage-summary.json", "utf8"),
);
const metrics = ["statements", "branches", "functions", "lines"];
const files = Object.entries(summary)
  .filter(([file]) => file !== "total")
  .map(([file, coverage]) => ({
    file: relative(process.cwd(), file).replaceAll("\\", "/"),
    coverage,
  }));

function aggregate(entries) {
  return Object.fromEntries(
    metrics.map((metric) => {
      const total = entries.reduce((sum, entry) => sum + entry.coverage[metric].total, 0);
      const covered = entries.reduce((sum, entry) => sum + entry.coverage[metric].covered, 0);
      return [metric, { pct: total === 0 ? 100 : Math.floor((covered / total) * 10000) / 100 }];
    }),
  );
}

function table(rows) {
  return [
    "| Scope / file | Statements | Branches | Functions | Lines |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ({ file, coverage }) =>
        `| \`${file}\` | ${metrics.map((metric) => `${coverage[metric].pct}%`).join(" | ")} |`,
    ),
  ].join("\n");
}

const scopes = ["src/admin/", "src/events/", "src/join/", "src/sessions.ts"];
const scoped = scopes.map((scope) => {
  const entries = files.filter(({ file }) =>
    scope.endsWith("/") ? file.startsWith(scope) : file === scope,
  );
  if (entries.length === 0) throw new Error(`Coverage report is missing required scope: ${scope}`);
  return { file: scope, coverage: aggregate(entries) };
});
const leastCovered = [...files]
  .sort((a, b) => a.coverage.lines.pct - b.coverage.lines.pct || a.file.localeCompare(b.file))
  .slice(0, 10);

console.log(
  [
    "## Vitest coverage",
    "",
    `All ${files.length} source files are included, including untested modules. Floors live in \`vitest.config.ts\`.`,
    "",
    table([{ file: "All source files", coverage: summary.total }, ...scoped]),
    "",
    "### Top 10 least-covered files (line coverage, path tie-break)",
    "",
    table(leastCovered),
    "",
    "Download the coverage artifact for the HTML report, LCOV and JSON summary.",
  ].join("\n"),
);
