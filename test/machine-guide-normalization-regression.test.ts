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
  ])("allows neutral scoped prose %j", (prose) => {
    const result = run(prose);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
    expect(result.stderr).toBe("");
  });
});
