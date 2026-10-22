// Acceptance: the web live-data lint blocks hard-coded Discord facts in web/src.
//
// Owned by the acceptance author: the builder implements against this file
// and never edits it. If a pin here is wrong, the test returns to the
// acceptance author instead of being adjusted on the builder card.
//
// Proposed contract (the builder wires the same):
// - Gate: ci/check-web-live-data.mjs, run as
//   `node ci/check-web-live-data.mjs --root <dir>`, scanning
//   `<dir>/web/src/**`.
// - Exit 0 when clean; exit 1 when a violation is found, naming each
//   offending file path on stdout or stderr; exit 2 on a usage error
//   (unknown flag, missing or unreadable root): a gate that cannot run
//   fails closed, never silent green.
// - Rules: (a) hard-coded guild/channel id literals (Discord snowflake
//   digit runs) and discord.gg/ strings outside the allowlisted invite
//   module and documented env readers; (b) day-of-week + time literals
//   such as 'Sunday 8pm'; (c) schedule strings in web/src.
// - Allowlist pinned here: web/src/**/invite.ts may mention invite hosts.
//   Env-reader allowlist entries are the builder's documented choice and
//   carry the builder's own unit tests.
//
// Fixture strings below are the contract: the lint must flag them, and the
// clean fixture must pass. Ids and invite codes here are fake
// (repeating-digit snowflakes, fixture invite codes), never live data.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPO_ROOT, "ci", "check-web-live-data.mjs");

const scratchRoots: string[] = [];

afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function scratchBase(): string {
  return process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
}

function writeFixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(scratchBase(), "web-live-data-"));
  scratchRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function runGate(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("web live-data lint acceptance", () => {
  it("provides the gate at the contracted path", () => {
    expect(existsSync(GATE)).toBe(true);
  });

  it("fails a hard-coded guild/channel id literal in web/src", () => {
    const root = writeFixtureTree({
      "web/src/lib/voice.ts":
        'export const GUILD_ID = "111122223333444555";\nexport const FALLBACK_CHANNEL_ID = "777788889999000111";\n',
    });
    const { status, output } = runGate(["--root", root]);
    expect(status).toBe(1);
    expect(output).toContain("voice.ts");
  });

  it("fails a discord.gg string outside the invite module", () => {
    const root = writeFixtureTree({
      "web/src/lib/EventCard.svelte":
        '<script lang="ts">\n  export let title: string;\n  const invite = "https://discord.gg/fixture12ab";\n</script>\n<a href={invite}>Join {title} voice</a>\n',
    });
    const { status, output } = runGate(["--root", root]);
    expect(status).toBe(1);
    expect(output).toContain("EventCard.svelte");
  });

  it("passes a discord.gg string inside the allowlisted invite module", () => {
    const root = writeFixtureTree({
      "web/src/lib/invite.ts":
        'export const INVITE_HOST = "discord.gg";\nexport function inviteUrl(code: string): string {\n  return "https://discord.gg/" + code;\n}\n',
    });
    const { status } = runGate(["--root", root]);
    expect(status).toBe(0);
  });

  it("fails a day-of-week + time channel-name literal", () => {
    const root = writeFixtureTree({
      "web/src/lib/names.ts": 'export const GAMES_NIGHT_CHANNEL = "Sunday 8pm";\n',
    });
    const { status, output } = runGate(["--root", root]);
    expect(status).toBe(1);
    expect(output).toContain("names.ts");
  });

  it("fails a schedule string in web/src", () => {
    const root = writeFixtureTree({
      "web/src/routes/events/+page.svelte":
        '<script lang="ts">\n  const cadence = "Every Sunday at 20:00";\n</script>\n<p>Games night: {cadence}</p>\n',
    });
    const { status, output } = runGate(["--root", root]);
    expect(status).toBe(1);
    expect(output).toContain("+page.svelte");
  });

  it("passes a clean fixture with live data passed in as props", () => {
    const root = writeFixtureTree({
      "web/src/lib/VoiceJoin.svelte":
        '<script lang="ts">\n  export let inviteUrl: string;\n  export let state: string;\n</script>\n{#if state === "live"}\n  <a href={inviteUrl}>Join voice</a>\n{:else}\n  <p>Voice opens shortly before start.</p>\n{/if}\n',
      "web/src/lib/voice.ts":
        'export type VoiceState = "tbd" | "live" | "after-party" | "hidden";\nexport function voiceLabel(state: VoiceState): string {\n  return state === "live" ? "Join voice" : "Voice unavailable";\n}\n',
    });
    const { status } = runGate(["--root", root]);
    expect(status).toBe(0);
  });

  it("fails closed with exit 2 on an unreadable root", () => {
    const { status } = runGate(["--root", join(scratchBase(), "missing-root-does-not-exist")]);
    expect(status).toBe(2);
  });

  it("writes fixture trees the gate can read (harness control)", () => {
    const root = writeFixtureTree({ "web/src/lib/probe.ts": "export const probe = 1;\n" });
    expect(existsSync(join(root, "web", "src", "lib", "probe.ts"))).toBe(true);
  });
});
