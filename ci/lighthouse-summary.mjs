// One actionable summary for the web quality gate: per-route Lighthouse category scores vs ci/quality-budget.json,
// the failing audits behind any miss, and the heaviest offending resources, plus the web-standards findings.
// Written to .lighthouseci/quality-summary.md and printed (CI appends it to the job summary). Never fails the job:
// the lhci and web-standards steps own the verdict. --selftest checks the formatter on a synthetic report.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const budget = JSON.parse(readFileSync(new URL("./quality-budget.json", import.meta.url), "utf8"));

export function routeOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function summarize(lhrs, minScores) {
  const byRoute = new Map();
  for (const lhr of lhrs) {
    const route = routeOf(lhr.finalDisplayedUrl || lhr.requestedUrl || "");
    byRoute.set(route, [...(byRoute.get(route) ?? []), lhr]);
  }
  const lines = [
    "## Lighthouse quality (desktop)",
    "",
    `| route | ${Object.keys(minScores).join(" | ")} |`,
    `|---|${Object.keys(minScores)
      .map(() => "---")
      .join("|")}|`,
  ];
  const misses = [];
  for (const [route, runs] of byRoute) {
    // The middle run by performance score stands for the route (lhci's median-run).
    runs.sort(
      (a, b) => (a.categories?.performance?.score ?? 0) - (b.categories?.performance?.score ?? 0),
    );
    const lhr = runs[Math.floor(runs.length / 2)];
    const cells = Object.entries(minScores).map(([cat, min]) => {
      const score = lhr.categories?.[cat]?.score;
      const pct = score == null ? "n/a" : Math.round(score * 100);
      if (score == null || score < min) {
        misses.push({ route, cat, score, min, lhr });
        return `**${pct}** (< ${Math.round(min * 100)})`;
      }
      return String(pct);
    });
    lines.push(`| ${route} | ${cells.join(" | ")} |`);
  }
  if (misses.length) {
    lines.push("", "### What to fix (fix the cause; do not lower ci/quality-budget.json)", "");
    for (const { route, cat, lhr } of misses) {
      const refs = lhr.categories[cat]?.auditRefs ?? [];
      const failing = refs
        .filter((r) => r.weight > 0 && (lhr.audits[r.id]?.score ?? 1) < 0.9)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);
      lines.push(`- **${route} ${cat}**:`);
      for (const r of failing) {
        const audit = lhr.audits[r.id];
        lines.push(`  - ${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ""}`);
        const items = (audit.details?.items ?? [])
          .filter((i) => i.url || i.node?.snippet)
          .sort((a, b) => (b.wastedBytes ?? b.wastedMs ?? 0) - (a.wastedBytes ?? a.wastedMs ?? 0))
          .slice(0, 3);
        for (const i of items)
          lines.push(
            `    - ${i.url ?? i.node.snippet}${i.wastedBytes ? ` (${Math.round(i.wastedBytes / 1024)} KiB)` : ""}`,
          );
      }
    }
  }
  return lines.join("\n") + "\n";
}

function loadLhrs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((r) => r.categories);
}

function selftest() {
  const lhr = (url, a11y) => ({
    requestedUrl: url,
    categories: {
      performance: { score: 0.95, auditRefs: [] },
      accessibility: { score: a11y, auditRefs: [{ id: "color-contrast", weight: 7 }] },
    },
    audits: {
      "color-contrast": {
        title: "Contrast",
        score: 0,
        details: { items: [{ node: { snippet: "<a class=x>" } }] },
      },
    },
  });
  const out = summarize([lhr("http://h/", 0.9), lhr("http://h/", 0.9), lhr("http://h/faq", 1)], {
    performance: 0.9,
    accessibility: 0.95,
  });
  assert.match(out, /\| \/ \| 95 \| \*\*90\*\* \(< 95\) \|/);
  assert.match(out, /\| \/faq \| 95 \| 100 \|/);
  assert.match(out, /Contrast/);
  assert.match(out, /<a class=x>/);
  console.log("lighthouse-summary selftest: ok");
}

if (process.argv.includes("--selftest")) selftest();
else {
  const parts = [];
  const lhrs = loadLhrs(".lighthouseci/quality");
  parts.push(
    lhrs.length
      ? summarize(lhrs, budget.categories)
      : "## Lighthouse quality\n\nNo quality reports (the step did not run or failed before collecting).\n",
  );
  if (existsSync(".lighthouseci/standards-summary.md"))
    parts.push(readFileSync(".lighthouseci/standards-summary.md", "utf8"));
  const text = parts.join("\n");
  writeFileSync(".lighthouseci/quality-summary.md", text);
  console.log(text);
}
