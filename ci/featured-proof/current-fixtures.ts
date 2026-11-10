// Current-source fictional SSR only. Never connects to an app or database.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { jsx } from "hono/jsx/jsx-runtime";
import { FeaturedFormPage, FeaturedPage } from "../../src/admin/pages";
import type { FeaturedRow } from "../../src/admin/store";
import { parseFeaturedListQuery } from "../../src/admin/table-list";
import { Layout, SiteFooter, SiteHeader } from "../../src/pages";
import {
  LEAF_CRITICAL_CSS_SHA256,
  SCHEDULE_CRITICAL_CSS_SHA256,
} from "../../src/leaf-critical-css";

async function main() {
  const output = resolve(process.argv[2]!);
  const sourceHead = process.env.PROOF_CHECKOUT_HEAD;
  if (!sourceHead || !/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error("Exact source head required");
  const now = new Date("2026-09-30T20:00:00Z");
  const row: FeaturedRow = {
    id: 1, legacyId: null, title: "Friday games", body: "Bring a friend. Everyone is welcome.",
    url: "https://example.test/games", imageUrl: null, imageAlt: null,
    isPublished: true, position: 0, startsAt: new Date("2026-09-30T19:00:00Z"),
    endsAt: new Date("2026-09-30T21:00:00Z"), createdBy: "fixture",
    createdAt: now, updatedAt: now,
  };
  const scheduled = { ...row, id: 2, title: "Next games and community workshops for newcomers", startsAt: new Date("2026-10-01T20:00:00Z"), endsAt: null };
  const longContent = { ...row, title: "a".repeat(255), body: `https://example.test/${"a".repeat(400)}` };
  const rows = [
    row, scheduled,
    { ...row, id: 3, title: "Past games", endsAt: now },
    { ...row, id: 4, title: "Draft games", isPublished: false },
  ];
  const values = {
    title: row.title, body: row.body, url: row.url, is_published: "on", position: "0",
    starts_at: "2026-09-30 19:00", ends_at: "2026-09-30 21:00",
  };
  const css = await readFile("public/styles.css");
  const stylesheet = `data:text/css;base64,${css.toString("base64")}`;
  // Fictional upcoming /events document through the real Layout
  // inlineScheduleCss path (the same Layout + header + events-page main +
  // footer structure the schedule shell renders): L then S as two <style>
  // blocks, no stylesheet links. The shell module itself is deliberately not
  // imported so the fixture's rendered-module scope stays inside the
  // already-covered shell modules. Children mirror the schedule-heading +
  // events-list shape produced for upcoming games; content is fictional,
  // no database.
  const upcomingMarkup = jsx(Layout, {
    title: "Events — Together We Own",
    canonical: "https://next.example.test/events",
    shareDescription: "Game nights, tournaments and whatever else the community puts on.",
    theme: "schedule",
    inlineScheduleCss: true,
    children: [
      jsx(SiteHeader, { active: "events" }),
      jsx("main", {
        class: "events-page",
        id: "main",
        tabindex: "-1",
        children: jsx("section", {
          "data-testid": "events-calendar",
          "aria-labelledby": "events-heading",
          children: [
            jsx("div", {
              class: "schedule-heading",
              children: [
                jsx("p", { class: "strap", children: "Community schedule" }),
                jsx("h1", { id: "events-heading", tabindex: "-1", children: "Events" }),
                jsx("p", { children: "Game nights, tournaments and whatever else the community puts on." }),
              ],
            }),
            jsx("ul", {
              "data-testid": "events-list",
              children: [
                jsx("li", {
                  class: "schedule-row",
                  children: [
                    jsx("span", { class: "schedule-date", children: ["Oct", jsx("strong", { children: "02" })] }),
                    jsx("div", {
                      class: "schedule-info",
                      children: [jsx("h2", { children: "Fictional Friday games" }), jsx("p", { children: "Fictional description for the offline browser proof." })],
                    }),
                    jsx("div", { class: "schedule-actions", children: jsx("span", { class: "schedule-attendance", children: "0 going" }) }),
                  ],
                }),
                jsx("li", {
                  class: "schedule-row",
                  children: [
                    jsx("span", { class: "schedule-date", children: ["Oct", jsx("strong", { children: "09" })] }),
                    jsx("div", {
                      class: "schedule-info",
                      children: [jsx("h2", { children: "Fictional community workshop" }), jsx("p", { children: "Second fictional upcoming entry." })],
                    }),
                    jsx("div", { class: "schedule-actions", children: jsx("span", { class: "schedule-attendance", children: "0 going" }) }),
                  ],
                }),
              ],
            }),
          ],
        }),
      }),
      jsx(SiteFooter, {}),
    ],
  });
  const fixtures = [
    ["edit.html", jsx(FeaturedFormPage, { mode: "edit", row, values, errors: {}, now, appUrl: "https://next.example.test" })],
    ["long-content.html", jsx(FeaturedFormPage, { mode: "edit", row: longContent, values: { ...values, title: longContent.title, body: longContent.body }, errors: {}, now, appUrl: "https://next.example.test" })],
    ["list.html", jsx(FeaturedPage, { rows, query: parseFeaturedListQuery({}), now })],
    ["scheduled.html", jsx(FeaturedFormPage, { mode: "edit", row: scheduled, values: { ...values, title: scheduled.title, starts_at: "2026-10-01 20:00", ends_at: "" }, errors: {}, now, appUrl: "https://next.example.test" })],
    ["upcoming.html", upcomingMarkup],
  ] as const;
  await mkdir(output); // Refuse to overwrite another evidence bundle.
  const manifest = [];
  for (const [name, markup] of fixtures) {
    // Fixture-only external stylesheet embedding; deployed markup is unmodified.
    // The guard island is an external script reference (no inline code); drop only that tag so other active content is still refused.
    // The upcoming document never embeds: a stylesheet link reintroduced by
    // the shell must fail below instead of becoming a blocked data URL.
    let html = String(markup)
      .replace(/<script src="\/islands\/admin-event-editor\.js" defer(?:="")?\s*\/?>(?:<\/script>)?/g, "");
    if (name === "upcoming.html") {
      // Offline determinism: the header logo would otherwise be a blocked
      // external request and a broken image in the capture; drop only the
      // <img> tag. Deployed markup is unmodified. The two production
      // <style> blocks are allowed here and hash-pinned below.
      html = html.replace(/<img\b[^>]*>/gi, "");
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      if (styles.length !== 2) throw new Error("Upcoming fixture must carry exactly two style blocks");
      if (createHash("sha256").update(styles[0]!).digest("base64") !== LEAF_CRITICAL_CSS_SHA256) throw new Error("Upcoming L hash mismatch");
      if (createHash("sha256").update(styles[1]!).digest("base64") !== SCHEDULE_CRITICAL_CSS_SHA256) throw new Error("Upcoming S hash mismatch");
      const rest = html.replace(/<style>[\s\S]*?<\/style>/g, "");
      // Attribute-order independent: ANY stylesheet link fails here,
      // whatever its href (named sheet, data URL, or other) — the inline
      // path must not link stylesheets at all.
      const linked = [...rest.matchAll(/<link\b[^>]*>/gi)].some((m) => /\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(m[0]));
      if (linked) throw new Error("Upcoming fixture must not link stylesheets");
      if (/<script\b|\sstyle=|\son\w+=/i.test(rest)) throw new Error("Active or inline content refused");
    } else {
      html = html.replace('href="/styles.css"', `href="${stylesheet}"`);
      if (/<script\b|<style\b|\sstyle=|\son\w+=/i.test(html)) throw new Error("Active or inline content refused");
    }
    await writeFile(join(output, name), html);
    manifest.push({ name, sha256: createHash("sha256").update(html).digest("hex") });
  }
  await writeFile(join(output, "manifest.json"), JSON.stringify({
    sourceHead, fixtureClock: now.toISOString(), fixtures: manifest,
    eventsCspHashes: { leaf: LEAF_CRITICAL_CSS_SHA256, schedule: SCHEDULE_CRITICAL_CSS_SHA256 },
    eventsStyleBlocks: ["L", "S"],
    mode: "current-source offline SSR; no deployed app, database, image network, or save-interaction proof",
  }, null, 2) + "\n");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
