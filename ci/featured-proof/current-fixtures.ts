// Current-source fictional SSR only. Never connects to an app or database.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { jsx } from "hono/jsx/jsx-runtime";
import { FeaturedFormPage, FeaturedPage } from "../../src/admin/pages";
import type { FeaturedRow } from "../../src/admin/store";

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
  const scheduled = { ...row, id: 2, title: "Next games", startsAt: new Date("2026-10-01T20:00:00Z"), endsAt: null };
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
  const fixtures = [
    ["edit.html", jsx(FeaturedFormPage, { mode: "edit", row, values, errors: {}, now, appUrl: "https://next.example.test" })],
    ["list.html", jsx(FeaturedPage, { rows, now })],
    ["scheduled.html", jsx(FeaturedFormPage, { mode: "edit", row: scheduled, values: { ...values, title: scheduled.title }, errors: {}, now, appUrl: "https://next.example.test" })],
  ] as const;
  await mkdir(output); // Refuse to overwrite another evidence bundle.
  const manifest = [];
  for (const [name, markup] of fixtures) {
    // Fixture-only external stylesheet embedding; deployed markup is unmodified.
    const html = String(markup).replace('href="/styles.css"', `href="${stylesheet}"`);
    if (/<script\b|<style\b|\sstyle=|\son\w+=/i.test(html)) throw new Error("Active or inline content refused");
    await writeFile(join(output, name), html);
    manifest.push({ name, sha256: createHash("sha256").update(html).digest("hex") });
  }
  await writeFile(join(output, "manifest.json"), JSON.stringify({
    sourceHead, fixtureClock: now.toISOString(), fixtures: manifest,
    mode: "current-source offline SSR; no deployed app, database, image network, or save-interaction proof",
  }, null, 2) + "\n");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
