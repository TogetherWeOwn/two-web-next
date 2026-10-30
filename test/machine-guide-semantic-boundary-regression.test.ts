// Complete offline CLI controls for quantitative complements and local clause scope.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url));
const guide = readFileSync(join(repo, "docs/machine-interface.md"), "utf8");
const env = { ...process.env };
for (const name of Object.keys(env))
  if (name.includes("DATABASE_URL") || name.startsWith("PG")) delete env[name];

describe("machine guide quantitative complements and local clauses (offline)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "guide-semantics-"));
    for (const dir of ["ci", "src"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
    mkdirSync(join(root, "docs"));
    for (const file of ["package.json", "tsconfig.json"])
      copyFileSync(join(repo, file), join(root, file));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function run(prose: string) {
    writeFileSync(join(root, "docs/machine-interface.md"), `${guide}\n${prose}\n`);
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "ci/check-machine-contract.mjs", "--format", "json"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
  }

  it.each([
    ...["with all fields", "or more", "including its structuredContent"].flatMap((suffix) => [
      `Every event result is one megabyte ${suffix}.`,
      `Every event CallToolResult is one megabyte ${suffix}.`,
    ]),
    ...["rather than 20", "instead of 20", "or more", "and archived nightly"].flatMap((suffix) => [
      `Rows are limited to 30 ${suffix}.`,
      `Collections have a limit of 30 ${suffix}.`,
    ]),
    ...[
      "in its data array",
      "returned per response",
      "listed in its data array",
      "returned for each successful response",
    ].map((suffix) => `Each response contains one row per event and 30 rows ${suffix}.`),
    "Each response contains one row per event and 30 rows and 40 rows per response.",
    "Each response's data array contains 30 rows across two pages.",
    "<div>Each successful list_events response contains at most</div><div>30 rows.</div>",
    ...[
      "Each successful list_events response contains",
      "There are",
      "The list_events page size is",
    ].flatMap((prefix) =>
      ["(", "[", '"'].flatMap((open) => {
        const close = open === "(" ? ")" : open === "[" ? "]" : '"';
        return [
          `<div>${prefix} ${open}</div><div>30${close} rows per response.</div>`,
          `<div>${prefix} at most ${open}</div><div>30${close} rows per response.</div>`,
        ];
      }),
    ),
    "In the seating chart, there are 30 rows per response.",
    "In the seating chart, there are 30 rows per page in each response.",
    "<div>Each response contains one row per event and (</div><div>30) rows per response.</div>",
    "In each list_events response, there are 30 rows.",
    "For each list_events response, there are 30 published events.",
    "There are 30 rows per event in each response.",
    "In each response there are 30 rows.",
    "There are 30 rows per event for every successful list_events result.",
    "There are 30 rows per list_events response.",
    "<div>There are</div><div>30 rows per response.</div>",
    "<div>The list_events page size is</div><div>30 rows.</div>",
    "Each response contains one row per event and 30 rows in total.",
    "Each response contains at least 1 row per event.",
    "Each list_events response's data array contains 30 rows.",
    "Each list_events response contains 30 published events.",
    "Each list_events response may only contain 30 events.",
    "The list_events page size is 30 rows.",
    "Each list_events response contains as many as 30 events.",
    "Each list_events response contains a total of 30 items.",
    "<div>Collections contain 30 items</div><div>across two pages; there are 30 rows per response.</div>",
    ...["paginated", "JSON-RPC"].map(
      (qualifier) =>
        `The data array of a single ${qualifier} list_events CallToolResult contains 30 rows across two pages.`,
    ),
    "Collections contain 30 items across two pages, per result.",
    "Collections contain 30 items across two pages in each individual response.",
    "<div>Each successful list_events response contains</div><div>30 rows per response.</div>",
    "<div>Each successful list_events response</div><div>contains</div><div>30 rows per response.</div>",
    "<div>Each list_events response's data array contains</div><div>30 rows.</div>",
    ...["including", "as well as"].map(
      (connector) =>
        `Collections contain 30 items across two pages, ${connector} 30 rows per response.`,
    ),
    "<div>Each response contains one row per event,</div><div>and 30 rows per response.</div>",
    "<div>Each response contains one row per event</div><div>and</div><div>30 rows per response.</div>",
    "<div>Each response contains one row per event,</div><div>as well as</div><div>30 rows per response.</div>",
    "Every event result is at least one megabyte.",
    "Every event CallToolResult is more than thirty megabytes.",
    "Every event result is as many as thirty megabytes.",
    "<div>Every event result is at least</div><div>one megabyte.</div>",
    ...["30", "1.1", ">=1", "1-2", "0"].map(
      (value) => `Each response contains ${value} rows per event.`,
    ),
    "Rows are limited to 30.",
    "<div>Rows are limited to 30</div><div>The guide explains sign-in.</div>",
    "<div>Rows are limited to 30</div><div>venues are listed.</div>",
    "<div>Published rows are limited to 30</div><div>venues, and there are 30 rows per response.</div>",
    "<div>Rows are limited to 30</div><div>venues appear on the seating chart.</div>",
    "<div>Rows are limited to</div><div>30</div><div>The guide explains sign-in.</div>",
    "Published rows are limited to 30 rows.",
    "<div>Published rows are limited to</div><div>30.</div>",
    "<div>Collections contain 30 items</div><div>Across two pages, the guide explains sign-in.</div>",
    "<div>Collections contain 30 items</div><div>across two pages, and 30 rows per response.</div>",
  ])("refuses quantitative boundary %j", (prose) => {
    const result = run(prose);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.verdict).toBe("fail");
    expect(
      receipt.failures.some((failure: string) =>
        failure.startsWith(
          "guide states a size or measurement claim outside the canonical Limits:",
        ),
      ),
    ).toBe(true);
    expect(receipt.failures).not.toContain("guide visible-text normalization succeeds");
    expect(result.stderr).toBe("");
  });

  it.each([
    ...[
      "Each response contains one row per event",
      "Collections contain 30 items across two pages",
    ].map((clause) => `${clause}, and 30 rows appear on each page of the venue seating chart.`),
    ...["", "only", "exactly", ":", "only:", "exactly:"].flatMap((prefix) =>
      ["1", "one"].map((value) => `Each response contains ${prefix} ${value} row per event.`),
    ),
    "Each response contains one row per event, and 30 events returned for another season.",
    "Each response contains one row per event, and 30 rows listed the venue names.",
    "Each response contains one row per event, and 30 rows published the seating plan.",
    ...["remain on", "were added to"].map(
      (predicate) =>
        `Each response contains one row per event, and 30 rows ${predicate} the venue seating chart.`,
    ),
    ...["or more", "or fewer", "rather than 20", "instead of 20"].map(
      (suffix) => `Rows are limited to 30 ${suffix} venues.`,
    ),
    "There are 30 rows in the seating chart.",
    "In the printed venue seating chart, there are 30 rows per page.",
    "For the venue seating chart, there are 30 rows per page.",
    "There are 30 rows per event in the seating chart.",
    ...[
      "Each successful list_events response contains",
      "There are",
      "The list_events page size is",
    ].flatMap((prefix) => [
      `<ul><li>${prefix} (</li><li>30) rows per response.</li></ul>`,
      `<table><tr><td>${prefix} (</td><td>30) rows per response.</td></tr></table>`,
      `<div>${prefix} (</div><div>8-bit entries).</div>`,
    ]),
    "Published rows are limited to 30 venues.",
    "Published rows are limited to 30 venues, and the guide explains sign-in.",
    "<div>Published rows are limited to 30</div><div>venues, and the guide explains sign-in.</div>",
    "<div>Published rows are limited to</div><div>30 venues.</div>",
    "<div>Published rows are limited to</div><div>30</div><div>venues.</div>",
    "<div>Published rows are limited to</div><div>entries from 30 venues.</div>",
    "Rows have a limit of 8-bit entries.",
    ...["1.0", "+1", "01", "+01.00", "(1.0)", "one"].map(
      (value) => `Each response contains ${value} rows per event.`,
    ),
    "<div>Collections contain 30 items</div><div>across two pages, and the guide explains sign-in.</div>",
    "Collections contain 30 items across two pages, and the guide explains sign-in.",
    "<div>Collections contain 30 items</div><div>across two pages; the guide explains sign-in.</div>",
    "<ul><li>Each successful list_events response contains</li><li>30 rows per response.</li></ul>",
    "<table><tr><td>Each successful list_events response contains</td><td>30 rows per response.</td></tr></table>",
    "<ul><li>Each response contains one row per event,</li><li>and 30 rows per response.</li></ul>",
    "<table><tr><td>Each response contains one row per event</td><td>and</td><td>30 rows per response.</td></tr></table>",
    "The response documents an at-least-one-megabyte venue upload field.",
    "Each response describes as many as thirty venue examples.",
    "Each response is logged, and collections contain 30 items across two pages.",
  ])("allows quantitative non-boundary %j", (prose) => {
    const result = run(prose);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
    expect(result.stderr).toBe("");
  });
});
