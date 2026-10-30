// Real offline CLI regressions for Markdown context and declaration scope.
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

describe("machine guide Markdown contexts and declarations (offline)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "guide-context-"));
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
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  }

  const refused = [
    "Link [hint](https://example.test/a`b). [Rows](https://example.test/docs) are limited to 30. See `help`.",
    "Link [hint](https://example.test/a%60b). [Rows](https://example.test/docs) are limited to 30. See `help`.",
    "A hint <!-- a ` marker --> [Rows](https://example.test/docs) are limited to 30. See `help`.",
    "A standalone ` tick.\n\n[Rows](https://example.test/docs) are limited to 30. Another ` tick.",
    "A ``literal ` marker``. [Rows](https://example.test/docs) are limited to 30.",
    "\\<response\\> is unlimited.",
    "An unfinished [link](.\n\n[Rows](https://example.test/docs) are limited to 30.",
    "[Rows] are limited to 30.\n\n[Rows]: https://example.test/docs",
    "<div>The limit for this endpoint is.&nbsp64KB",
    "<p>Events.</p><table><tr><td>Venue schedules.</td>Rows are limited to 30.</tr></table>",
    "<p>Events.</p><table><tr><td>Rows are limited to 30.</td></tr></table>",
    "Event collection responses contain 30 rows-per-response.",
    "Collections can contain 50 rows per response.",
    "Each page contains 30 items.",
    "A collection has 30 items per page.",
    "Collections contain 30-item pages.",
    "Event results are uncapped.",
    "An event result can be as large as one megabyte.",
    "Collections contain 30 items per response.",
    "Responses contain 30 rows-per-page.",
    "Rows<br>are limited to 30.",
    "<noscript>Responses occupy 32 KB.</noscript>",
    "<iframe>Responses occupy 32 KB.</iframe>",
    "Collections contain 30 items across two pages and the response contains 30 rows.",
    ...["unlimited", "unbounded", "uncapped"].map(
      (predicate) => `<div>Responses are</div><div>${predicate}.</div>`,
    ),
    "<div>Rows</div>\n\n<div>are limited to 30.</div>",
    "<header>Rows</header><main>are limited to 30.</main>",
    "Each response contains 30 events.",
    "Each page contains thirty events.",
    "Event results occupy one megabyte.",
    "Collections contain 30 items-per-response across two pages.",
    "Responses contain 30 items across venue categories and collections contain 40 rows across two pages.",
    "Collections have 30 items.",
    "The result is one megabyte.",
    ...["contain", "include", "return", "hold", "show", "have"].map(
      (verb) => `<div>Collections</div><div>${verb} 30 items.</div>`,
    ),
    "<div>Event results</div><div>occupy one megabyte.</div>",
    "<div>The result is</div><div>one megabyte.</div>",
    "<div>Collections have</div><div>30 items.</div>",
    "Collections contain 30 items across venue categories, and venue pages are public.",
    "<div>Collections have</div><div>30</div><div>items.</div>",
    "<div>The result is</div><div>one</div><div>megabyte.</div>",
    "<div>Collections have</div><div>one</div><div>hundred</div><div>items.</div>",
    "<div>Collections have 30 items.</div><div>across two pages.</div>",
    "<div>Collections have 30 items-per-response</div><div>across two pages.</div>",
    "<ul><li>Collections have 30 items</li><li>across two pages.</li></ul>",
    ...[
      "Across two pages, the guide explains sign-in.",
      "Across the first two pages, the guide explains sign-in.",
      "Across two pages the guide explains sign-in.",
      "Across two pages. The guide explains sign-in.",
      "In total across two pages, the guide explains sign-in.",
      "Per event, the guide explains sign-in.",
    ].map((next) => `<div>Collections contain 30 items</div><div>${next}</div>`),
    ...["", " across two pages", " across the first two pages"].flatMap((tail) => [
      `The data array of a single list_events CallToolResult contains 30 rows${tail}.`,
      `A single list_events CallToolResult contains 30 rows${tail}.`,
      `Each response contains 30 rows${tail}.`,
      `One result contains 30 rows${tail}.`,
    ]),
    ...[
      "Rows are limited to",
      "Rows are capped at",
      "Rows are bounded to",
      "Rows have a limit of",
      "Items have an upper bound of",
      "The collection caps at",
      "The collection limit is",
      "Rows are limited to a maximum of",
    ].map((prefix) => `<div>${prefix}</div><div>30.</div>`),
    "<div>Rows are</div><div>limited</div><div>to</div><div>30.</div>",
    "<div>Rows have</div><div>a limit of</div><div>30.</div>",
    "<div>Rows are limited to</div><div>one</div><div>hundred.</div>",
    "Collections contain 30 items per response across the first two pages.",
    ...["A response", "The result", "A CallToolResult"].map(
      (subject) => `${subject} contains 30 rows across the first two pages.`,
    ),
    "Collections contain 30 items across the first two pages per response.",
    "Collections contain 30 items across two pages per page.",
    "Collections contain 37 items across the first two pages, per response.",
    "Collections contain 39 items across the first two pages, per page.",
    ...["per response.", "per page.", "per</div><div>response."].map(
      (suffix) =>
        `<div>Collections contain 30 items</div><div>across two pages</div><div>${suffix}</div>`,
    ),
    ...["two", "the first two"].map(
      (pages) =>
        `<div>Collections contain 30 items</div><div>across ${pages} pages</div><div>, the guide explains sign-in.</div>`,
    ),
  ];
  it.each(refused)("refuses %j with a structured claim diagnostic", (prose) => {
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

  it.each(["can", "may", "will", "must"])("pins the %s count-modal branch", (modal) => {
    const claim = `Collections ${modal} contain 30 items.`;
    const result = run(claim);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      `guide states a size or measurement claim outside the canonical Limits: "${claim}"`,
    );
  });

  const wordUnits = [
    "bytes",
    "kilobytes",
    "megabytes",
    "gigabytes",
    "terabytes",
    "petabytes",
    "exabytes",
    "kibibytes",
    "mebibytes",
    "gibibytes",
    "tebibytes",
    "pebibytes",
    "exbibytes",
  ];
  it("pins every direct/copula word-size unit without cross-case masking", () => {
    const claims = wordUnits.flatMap((unit) => [
      `The result is two ${unit}.`,
      `Event results are two ${unit}.`,
      `The result can be as large as two ${unit}.`,
      `The result may be two ${unit}.`,
    ]);
    const prose = claims.join("\n");
    expect(`${guide}\n${prose}\n`.split("\n").length).toBeLessThanOrEqual(120);
    const result = run(prose);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.failure_count).toBe(claims.length);
    expect(
      receipt.failures.every((failure: string) =>
        failure.startsWith(
          "guide states a size or measurement claim outside the canonical Limits:",
        ),
      ),
    ).toBe(true);
  });
  it("keeps the paired word-size field examples neutral", () => {
    const result = run(
      wordUnits
        .map((unit) => `The response documents a two-${unit} venue upload field.`)
        .join("\n"),
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
  });
  it("keeps template ancestors across Markdown nodes without hiding outside claims", () => {
    const claim = "Rows are limited to 40.";
    const result = run(`<template>\n\nRows are limited to 30.\n\n</template>\n\n${claim}`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.failure_count).toBe(1);
    expect(receipt.failures).toContain(
      `guide states a size or measurement claim outside the canonical Limits: "${claim}"`,
    );
  });

  it("does not mistake punctuation in a hidden title for the refused source sentence", () => {
    const result = run('[hint](https://example.test "A. B"). Rows are limited to 30.');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'guide states a size or measurement claim outside the canonical Limits: "Rows are limited to 30."',
    );
  });

  it("keeps the original refused HTML block after long neutral text", () => {
    const claim = "<p><b>Rows</b> are limited to 30.</p>";
    const result = run(`<p>${"Venue schedules are available. ".repeat(20)}</p>${claim}`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      `guide states a size or measurement claim outside the canonical Limits: "${claim}" (visible: "Rows are limited to 30.")`,
    );
  });

  it("keeps fostered claim text instead of an enclosing neutral block", () => {
    const result = run(
      `<div><p>${"Neutral ".repeat(40)}</p><table><tr><td>Venue.</td>Rows are limited to 30.</tr></table></div>`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'guide states a size or measurement claim outside the canonical Limits: "Rows are limited to 30." (visible: "Rows are limited to 30.")',
    );
  });

  it.each([
    '<span title="a`b">Use the documentation.</span> See `help`.',
    "<noscript>Read Terms &amp; Conditions.</noscript>",
    "<iframe>Read Terms &amp; Conditions.</iframe>",
    "The collection includes 30 items across two pages.",
    "Collections contain 30 entries in total across multiple pages.",
    "Results show 1 row per event.",
    "<ul><li>Response schemas</li><li>Limited availability</li></ul>",
    "Responses can contain 8-bit entries.",
    "Each page contains 30 venue examples.",
    "A collection has 30 venue examples.",
    "Collections contain 30 entries-per-hour.",
    "Responses return 30 items-per-day.",
    "Collections include 30 per-page settings.",
    "The response describes a one-megabyte venue upload field.",
    "<ul><li>Responses</li><li>are limited to 30</li></ul>",
    "<table><tr><td>Responses</td><td>are limited to 30</td></tr></table>",
    "Res__ult__s are unlimited.",
    "Collections contain 30 items across two pages, and venue schedules are published per page.",
    "The collection contains 30 items in total, across two pages.",
    "<div>Collections have</div><div>8-bit entries.</div>",
    "<div>The result is</div><div>a one-megabyte venue upload field.</div>",
    "<div>Collections have</div><div>30</div><div>items</div><div>across two pages.</div>",
    "<div>Collections have 30 items</div><div>in total,</div><div>across</div><div>the two pages.</div>",
    "<div>Results show</div><div>one</div><div>row</div><div>per</div><div>event.</div>",
    ...[
      "all",
      "both",
      "multiple",
      "several",
      "many",
      "some",
      "the",
      "30",
      "twenty-five",
      "all the",
      "the two",
      "both the two",
    ].map((pages) => `Collections contain 30 items across ${pages} pages.`),
    "For a stable collection of 30 renderable published events and successful 20-per-page requests, collections contain 30 items across the first two pages.",
    ...["first two", "last 2", "next three", "previous twenty-five"].flatMap((pages) => [
      `Collections contain 30 items across the ${pages} pages.`,
      `<div>Collections contain 30 items</div><div>across the ${pages} pages.</div>`,
      `<div>Collections contain 30 items</div><div>across</div><div>the ${pages} pages.</div>`,
    ]),
    "Each response is logged, and collections contain 30 items across two pages.",
    "Each response contains 1 row per event.",
    "A single list_events CallToolResult contains 1 row per event.",
    "The collection totals 30 events across the first two pages, with a single list_events CallToolResult containing at most 20 rows.",
    "<div>Collections contain 30 items</div><div>across two pages.</div>",
    "<div>Collections contain 30 items</div><div>across two pages</div><div>, with venue details.</div>",
    "Collections contain 30 items across two pages, with venue details.",
    "<div>Collections contain 31 items</div><div>across two pages</div><div>; the guide explains sign-in.</div>",
    "<div>Collections contain 30 items</div><div>across two pages.</div><div>Per request, the guide explains sign-in.</div>",
    "<div>Rows are limited to</div><div>published entries from 30 venues.</div>",
    "<div>Rows have a limit of</div><div>8-bit entries.</div>",
    "<ul><li>Rows are limited to</li><li>30.</li></ul>",
    "<table><tr><td>Rows are limited to</td><td>30.</td></tr></table>",
    "<template>Rows are limited to 30.</template>",
    "<template>\n\nRows are limited to 30.\n\n</template>",
    ...["can", "may", "will", "must"].map((modal) => `Collections ${modal} contain 8-bit entries.`),
  ])("allows neutral scoped prose %j", (prose) => {
    const result = run(prose);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
    expect(result.stderr).toBe("");
  });
});
