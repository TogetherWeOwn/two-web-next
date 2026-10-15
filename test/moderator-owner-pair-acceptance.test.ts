// Acceptance coverage for the moderator Owner+Moderator repoint (public PR #851).
//
// Each block below pins one review-finding area from that PR's Paperclip
// Review history, so the Land change cannot regress it with CI green:
//
// 1. Pair membership: a same-length wrong pair (Owner + unrelated id, or a
//    duplicated Owner) must fail `is-approved`. Forcing the membership clause
//    to `true` keeps every other probe suite green, so without these cases a
//    config that drops Moderator for an arbitrary role clears the preflight.
// 2. Guild binding: role IDs are guild-scoped, so the production pair in a
//    staging-guild config (and vice versa) must fail `guild-binding` even
//    though every other finding can pass.
// 3. Production gate: the `--env=production` CLI branch must read the named
//    environment's guild. Pointing it at the top-level guild (or dropping the
//    read) lets a staging-guild production config exit 0.
// 4. Missing or blank `DISCORD_GUILD_ID` with `--require-configured` must fail
//    `guild-binding` instead of silently falling back to the legacy check.
// 5. Unscoped reads keep the legacy behavior: a blank config without
//    `--require-configured` exits 0 with no `guild-binding` finding (the
//    documented local-dev revocation path).
//
// The pair and guild IDs below are the public staging/production values from
// the PR itself; the suites are offline (fixture configs and env only).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModerators } from "../src/probes/check-moderators";

// Production TWO guild pair: Owner + Moderator.
const PROD_OWNER = "1546777855801954408";
const PROD_MODERATOR = "1546777856984481792";
// Staging TWO guild pair: Owner + Moderator (unrelated snowflakes: role IDs
// are guild-scoped, never copy one guild's pair into the other's config).
const STAGING_OWNER = "1546211363578191873";
const STAGING_MODERATOR = "1545648550329851946";
const PROD_GUILD = "326474832151838730";
const STAGING_GUILD = "1545644954272137297";
// A well-formed snowflake that is not an approved role anywhere.
const UNRELATED = "100000000000000001";

const PROD_PAIR = `${PROD_OWNER},${PROD_MODERATOR}`;
const STAGING_PAIR = `${STAGING_OWNER},${STAGING_MODERATOR}`;

// Wide options type: the guild binding rides on `guildId`, which predates
// nothing here — passing a variable (never a fresh literal) keeps this file
// type-clean whether or not the probe already accepts the option.
type GuildOpts = { requireConfigured?: boolean; guildId?: string };
const withGuild = (guildId: string): GuildOpts => ({ requireConfigured: true, guildId });

type Finding = { name: string; status: string };
const findingStatus = (probe: { findings: Finding[] }, name: string): string | undefined =>
  probe.findings.find((f) => f.name === name)?.status;
const hasFinding = (probe: { findings: Finding[] }, name: string): boolean =>
  probe.findings.some((f) => f.name === name);

describe("moderator pair membership (Owner+Moderator)", () => {
  it("accepts exactly the approved production pair", () => {
    const p = checkModerators(PROD_PAIR, { requireConfigured: true });
    expect(p.ok).toBe(true);
    expect(findingStatus(p, "is-approved")).toBe("PASS");
  });

  it("accepts the pair in either order", () => {
    const p = checkModerators(`${PROD_MODERATOR},${PROD_OWNER}`, { requireConfigured: true });
    expect(p.ok).toBe(true);
    expect(findingStatus(p, "is-approved")).toBe("PASS");
  });

  it.each([`${PROD_OWNER},${UNRELATED}`, `${PROD_OWNER},${PROD_OWNER}`])(
    "rejects a same-length wrong pair: %s",
    (raw) => {
      const p = checkModerators(raw, { requireConfigured: true });
      expect(p.ok).toBe(false);
      expect(findingStatus(p, "is-approved")).toBe("FAIL");
    },
  );
});

describe("moderator guild binding", () => {
  it("binds the staging pair to the staging guild", () => {
    const p = checkModerators(STAGING_PAIR, withGuild(STAGING_GUILD));
    expect(p.ok).toBe(true);
    expect(findingStatus(p, "guild-binding")).toBe("PASS");
  });

  it("fails the production pair in the staging guild", () => {
    const p = checkModerators(PROD_PAIR, withGuild(STAGING_GUILD));
    expect(p.ok).toBe(false);
    expect(findingStatus(p, "guild-binding")).toBe("FAIL");
  });

  it("fails the staging pair in the production guild", () => {
    const p = checkModerators(STAGING_PAIR, withGuild(PROD_GUILD));
    expect(p.ok).toBe(false);
    expect(findingStatus(p, "guild-binding")).toBe("FAIL");
  });

  it("fails an unknown guild instead of falling back", () => {
    const p = checkModerators(PROD_PAIR, withGuild("999999999999999999"));
    expect(p.ok).toBe(false);
    expect(findingStatus(p, "guild-binding")).toBe("FAIL");
    expect(findingStatus(p, "is-approved")).toBe("FAIL");
  });

  it("emits no guild-binding finding for legacy callers without a guild", () => {
    const p = checkModerators(PROD_PAIR, { requireConfigured: true });
    expect(hasFinding(p, "guild-binding")).toBe(false);
  });
});

type CliJson = {
  ok: boolean;
  failures: number;
  unknowns: number;
  results: Finding[];
} | null;

function runConfigCli(
  configText: string,
  extraArgs: string[],
  flags: string[] = ["--require-configured"],
): { status: number; json: CliJson; stderr: string } {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "modpair-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    writeFileSync(path, configText);
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "./bin/ts-hook.mjs",
        "bin/check-moderators.mjs",
        `--config=${path}`,
        ...extraArgs,
        ...flags,
        "--json",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "", DISCORD_GUILD_ID: "" },
      },
    );
    return {
      status: r.status ?? -1,
      json: r.stdout ? (JSON.parse(r.stdout) as CliJson) : null,
      stderr: r.stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cliFinding = (json: CliJson, name: string): string | undefined =>
  json?.results.find((f) => f.name === name)?.status;

describe("production gate reads the named environment guild", () => {
  const prodEnv = (roles: string, guild: string): string =>
    `{"vars": {}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${roles}", "DISCORD_GUILD_ID": "${guild}"}}}}`;

  it("fails env.production carrying the staging guild with the production pair", () => {
    const r = runConfigCli(prodEnv(PROD_PAIR, STAGING_GUILD), ["--env=production"]);
    expect(r.status).toBe(1);
    expect(cliFinding(r.json, "guild-binding")).toBe("FAIL");
  });

  it("fails env.production carrying the production guild with the staging pair", () => {
    const r = runConfigCli(prodEnv(STAGING_PAIR, PROD_GUILD), ["--env=production"]);
    expect(r.status).toBe(1);
    expect(cliFinding(r.json, "guild-binding")).toBe("FAIL");
  });

  it("passes env.production with the production guild and pair", () => {
    const r = runConfigCli(prodEnv(PROD_PAIR, PROD_GUILD), ["--env=production"]);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ failures: 0, ok: true });
  });
});

describe("missing or blank guild fails closed with --require-configured", () => {
  it("fails a config pair with no guild var", () => {
    const r = runConfigCli(`{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${PROD_PAIR}"}}`, []);
    expect(r.status).toBe(1);
    expect(cliFinding(r.json, "guild-binding")).toBe("FAIL");
  });

  it("fails a blank guild var", () => {
    const r = runConfigCli(
      `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${PROD_PAIR}", "DISCORD_GUILD_ID": ""}}`,
      [],
    );
    expect(r.status).toBe(1);
    expect(cliFinding(r.json, "guild-binding")).toBe("FAIL");
  });

  it("fails env.production with a pair but no guild in the named env", () => {
    const r = runConfigCli(
      `{"vars": {}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${PROD_PAIR}"}}}}`,
      ["--env=production"],
    );
    expect(r.status).toBe(1);
    expect(cliFinding(r.json, "guild-binding")).toBe("FAIL");
  });
});

describe("unscoped config reads keep the legacy behavior", () => {
  it("blank config without --require-configured exits 0 with no guild-binding finding", () => {
    const r = runConfigCli(`{"vars": {}}`, [], []);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ ok: true, failures: 0, unknowns: 2 });
    expect(r.json?.results.some((f) => f.name === "guild-binding")).toBe(false);
  });
});
