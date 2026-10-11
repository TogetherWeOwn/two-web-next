import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installReadOnlyGuard } from "../watch-guard.mjs";
import { crawlablePath, EXPLORE_ORIGIN, findingId, severityFor } from "./crawl-utils.mjs";

// Guest explorer (docs/explore-staging.md): breadth-first crawl of the staging
// Worker at desktop and mobile widths, recording breakage as findings in
// explore-results/findings.json (+ screenshots). Report-only: findings never
// fail the run; the daily QA routine triages them into cards. The run fails
// only when the explorer itself cannot work (home page not 200).
const MAX_PAGES = 40;
const OUT = "explore-results";
const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;

type Finding = {
  id: string;
  kind: string;
  severity: string;
  viewport: string;
  path: string;
  detail: string;
  screenshot?: string;
};

test("explore staging as a guest", async ({ browser }) => {
  mkdirSync(`${OUT}/shots`, { recursive: true });
  const findings: Finding[] = [];
  const crawled: string[] = [];
  const add = (f: Omit<Finding, "id" | "severity">) => {
    const finding = { ...f, id: findingId(f), severity: severityFor(f.kind, f.detail) };
    if (!findings.some((x) => x.id === finding.id)) findings.push(finding);
    return finding;
  };

  for (const { name: viewportName, viewport } of VIEWPORTS) {
    const context = await browser.newContext({
      viewport,
      baseURL: EXPLORE_ORIGIN,
      serviceWorkers: "block",
      storageState: { cookies: [], origins: [] },
    });
    const guard = await installReadOnlyGuard(context);
    const queue = ["/"];
    const seen = new Set(queue);
    while (queue.length > 0 && seen.size <= MAX_PAGES + queue.length) {
      const path = queue.shift() as string;
      const page = await context.newPage();
      const before = findings.length;
      const problems = observe(page);
      const response = await page.goto(path, { waitUntil: "load" }).catch(() => null);
      const status = response?.status() ?? 0;
      if (path === "/" && viewportName === "desktop") expect(status, "staging home").toBe(200);
      crawled.push(`${viewportName} ${path} ${status}`);
      if (status >= 400 || status === 0)
        add({ kind: "status", viewport: viewportName, path, detail: String(status) });
      for (const p of problems)
        add({ kind: p.kind, viewport: viewportName, path, detail: p.detail });
      if (status === 200) {
        await checkPage(page, viewportName, path, add);
        for (const href of await page.$$eval("a[href]", (as) =>
          as.map((a) => a.getAttribute("href") ?? ""),
        )) {
          const next = crawlablePath(href, page.url());
          if (next && !seen.has(next) && seen.size < MAX_PAGES) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      if (findings.length > before) {
        const shot = `shots/${viewportName}${path.replace(/[^a-z0-9]+/gi, "_") || "_root"}.png`;
        await page.screenshot({ path: `${OUT}/${shot}`, fullPage: true }).catch(() => undefined);
        for (const f of findings.slice(before)) f.screenshot = shot;
      }
      await page.close();
    }
    for (const write of guard.violations)
      add({ kind: "write-attempt", viewport: viewportName, path: "*", detail: write });
    await context.close();
  }

  const report = { origin: EXPLORE_ORIGIN, ranAt: new Date().toISOString(), crawled, findings };
  writeFileSync(`${OUT}/findings.json`, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = findings
      .sort((a, b) => a.severity.localeCompare(b.severity))
      .map(
        (f) =>
          `| ${f.severity} | ${f.kind} | ${f.viewport} | \`${f.path}\` | ${f.detail.slice(0, 120).replace(/\|/g, "\\|")} |`,
      );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## Staging explorer`,
        "",
        `${crawled.length} page visits, ${findings.length} finding(s)`,
        "",
        "| Severity | Kind | Viewport | Path | Detail |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  }
});

function observe(page: Page) {
  const problems: Array<{ kind: string; detail: string }> = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push({ kind: "console", detail: m.text() });
  });
  page.on("pageerror", (e) => problems.push({ kind: "pageerror", detail: e.message }));
  page.on("response", (r) => {
    if (
      r.status() >= 400 &&
      !r.request().isNavigationRequest() &&
      new URL(r.url()).origin === EXPLORE_ORIGIN
    )
      problems.push({ kind: "subresource", detail: `${r.status()} ${new URL(r.url()).pathname}` });
  });
  return problems;
}

async function checkPage(
  page: Page,
  viewport: string,
  path: string,
  add: (f: { kind: string; viewport: string; path: string; detail: string }) => unknown,
) {
  const overflow = Number(
    await page.evaluate("document.documentElement.scrollWidth - window.innerWidth"),
  );
  if (overflow > 1)
    add({
      kind: "overflow",
      viewport,
      path,
      detail: `page is ${overflow}px wider than the viewport`,
    });
  const broken = await page.$$eval("img", (imgs) =>
    imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src") ?? ""),
  );
  for (const src of broken) add({ kind: "broken-image", viewport, path, detail: src });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()
    .catch(() => null);
  for (const v of axe?.violations ?? []) {
    if (v.impact === "serious" || v.impact === "critical")
      add({
        kind: "axe",
        viewport,
        path,
        detail: `${v.impact} ${v.id}: ${v.help} (${v.nodes.length} node(s))`,
      });
  }
}
