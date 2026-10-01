import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POLICY_FILE, POLICY_VERSION } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleFile = "src/privacy-content.ts";
const bundle = readFileSync(resolve(root, bundleFile), "utf8");
const source = readFileSync(resolve(root, POLICY_FILE));
const command = bundle.match(/^\/\/ Regen[^\n]*: node -e '(.+)' (\S+)$/m);

function assertNoPolicyDrift(sourceBytes: Buffer, bundledMarkdown: string): void {
  expect(
    Buffer.from(bundledMarkdown, "utf8").equals(sourceBytes),
    `Privacy policy v${POLICY_VERSION} drift: ${bundleFile} does not byte-match ${POLICY_FILE}. ` +
      `Regenerate using the command at the top of ${bundleFile}; do not trim or normalize the source.`,
  ).toBe(true);
}

function regenerate(sourceBytes: Buffer, bundleText = bundle): { bundle: string; markdown: string } {
  const fixtureCommand = bundleText.match(/^\/\/ Regen[^\n]*: node -e '(.+)' (\S+)$/m);
  if (!fixtureCommand?.[1]) throw new Error(`Missing documented regeneration command in ${bundleFile}`);
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "privacy-generation-"));
  try {
    mkdirSync(join(scratch, dirname(POLICY_FILE)), { recursive: true });
    mkdirSync(join(scratch, dirname(bundleFile)), { recursive: true });
    writeFileSync(join(scratch, POLICY_FILE), sourceBytes);
    // Run the documented relative-path command in the fixture, never in the repository.
    execFileSync(process.execPath, ["-e", fixtureCommand[1], POLICY_FILE], { cwd: scratch, timeout: 5000 });
    const generated = readFileSync(join(scratch, bundleFile), "utf8");
    const literal = generated.match(/export const POLICY_MARKDOWN: string =\s*("(?:[^"\\]|\\.)*");/);
    if (!literal?.[1]) throw new Error(`Missing POLICY_MARKDOWN export in regenerated ${bundleFile}`);
    return { bundle: generated, markdown: JSON.parse(literal[1]) as string };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("privacy policy generation drift gate", () => {
  it("aligns the selected version, source, bundle header, and documented command", () => {
    expect(POLICY_FILE).toBe(`content/privacy-policy-v${POLICY_VERSION}.md`);
    expect(bundle.split("\n")[0]).toBe(`// GENERATED from ${POLICY_FILE} — do not hand-edit.`);
    expect(command?.[2], "Documented generator must use the selected policy source").toBe(POLICY_FILE);
  });

  it("byte-matches the selected source, documented generator output, and committed bundle", () => {
    // Compare Markdown bytes, not TypeScript formatting.
    assertNoPolicyDrift(source, regenerate(source).markdown);
    assertNoPolicyDrift(source, POLICY_MARKDOWN);
  });

  it("preserves its documented command when regenerating and reloading the bundle", () => {
    const generated = regenerate(source);
    const reloaded = regenerate(source, generated.bundle);
    expect(generated.bundle.split("\n")[1]).toBe(bundle.split("\n")[1]);
    expect(reloaded.bundle).toBe(generated.bundle);
    assertNoPolicyDrift(source, reloaded.markdown);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("preserves Unicode, JSON escapes, and %s newlines without trimming", (_label, newline) => {
    const fixture = Buffer.from(`## Fixture${newline}${newline}  "café" — 😀 \\path  ${newline}${newline}`, "utf8");
    assertNoPolicyDrift(fixture, regenerate(fixture).markdown);
  });

  it("preserves a source without a final newline", () => {
    const fixture = Buffer.from("## Fixture\n\nUnicode — 😀", "utf8");
    assertNoPolicyDrift(fixture, regenerate(fixture).markdown);
  });

  it("rejects a modified source fixture even when its opening heading is unchanged", () => {
    const modifiedSource = Buffer.concat([source, Buffer.from("\nFixture-only change.\n")]);
    expect(() => assertNoPolicyDrift(modifiedSource, POLICY_MARKDOWN)).toThrow(
      `Privacy policy v${POLICY_VERSION} drift: ${bundleFile} does not byte-match ${POLICY_FILE}`,
    );
  });

  it("rejects a modified bundle fixture with regeneration instructions", () => {
    expect(() => assertNoPolicyDrift(source, `${POLICY_MARKDOWN}\nFixture-only change.\n`)).toThrow(
      `Regenerate using the command at the top of ${bundleFile}`,
    );
  });

  it.each([
    ["a missing final newline", "## Fixture\n", "## Fixture"],
    ["an extra final newline", "## Fixture", "## Fixture\n"],
    ["normalized CRLF newlines", "## Fixture\n\nUnicode — 😀\n", "## Fixture\r\n\r\nUnicode — 😀\r\n"],
  ])("rejects %s in a bundle fixture", (_label, fixture, modifiedBundle) => {
    expect(() => assertNoPolicyDrift(Buffer.from(fixture, "utf8"), modifiedBundle)).toThrow(/Privacy policy v\d+ drift/);
  });
});
