import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Independent boundary contract, not implementation-derived expectations:
// stderr JSON = { schema: "operator-probe-error.v1", tool: basename without .mjs,
// mode: "error", ok: false, code: UPPER_SNAKE, message: static safe text,
// retryable: false, next_action: specific static recovery instruction }.
// No new success fields or code spellings are prescribed. The shared contract
// linked by both --help outputs must document these exact error fields/codes.
// Kills: reflected argv/paths, prose-in-JSON, changed exits/streams, raw catches,
// unstable taxonomy, source ambiguity/fallback, unbounded output and live effects.
const ROOT = resolve(".");
const DIR = mkdtempSync(
  join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(),
    "operator-refusals-",
  ),
);
const A = "100000000000000001";
const B = "100000000000000002";
const PRODUCTION_ROLES = "1546777855801954408,1546777856984481792";
const PRODUCTION_GUILD = "326474832151838730";
const MARKERS = ["ALPHA_SYNTHETIC_REJECTED_INPUT", "BRAVO_SYNTHETIC_REJECTED_INPUT"];
const TOOL_IDS = ["check-moderators", "role-audit"] as const;
type Tool = (typeof TOOL_IDS)[number];
type Result = {
  status: number | null;
  stdout: string;
  stderr: string;
  effects: { network: number; writes: number; reads: number };
};

// Child-only tripwires: use real CLI parsing, file reads and comparison logic.
// Record attempted effects even when a CLI catches the thrown tripwire. fd 3 is
// separate from both public streams, and is checked on every invocation.
const guard = join(DIR, "offline-guard.mjs");
writeFileSync(
  guard,
  `import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const effects = { network: 0, writes: 0, reads: 0 };
const write = fs.writeSync.bind(fs);
const read = fs.readFileSync.bind(fs);
fs.readFileSync = (path, ...args) => {
  if (String(path).startsWith(${JSON.stringify(DIR)})) effects.reads++;
  return read(path, ...args);
};
const deny = (kind) => () => { effects[kind]++; throw new Error("offline acceptance tripwire"); };
globalThis.fetch = deny("network");
net.Socket.prototype.connect = deny("network");
net.Server.prototype.listen = deny("network");
for (const mod of [http, https]) for (const name of ["request", "get"]) mod[name] = deny("network");
tls.connect = deny("network");
dgram.createSocket = deny("network");
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) dns[name] = deny("network");
for (const name of ["writeFile", "appendFile", "unlink", "rename", "mkdir", "rmdir", "rm", "truncate", "copyFile", "chmod", "chown", "symlink", "link", "write", "writev"]) {
  if (name in fs) fs[name] = deny("writes");
  if (name + "Sync" in fs) fs[name + "Sync"] = deny("writes");
  if (name in fsp) fsp[name] = deny("writes");
}
fs.createWriteStream = deny("writes");
for (const [mod, name] of [[fs, "openSync"], [fs, "open"], [fsp, "open"]]) {
  const open = mod[name].bind(mod);
  mod[name] = (path, flags, ...args) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : flags !== 0) return deny("writes")();
    return open(path, flags, ...args);
  };
}
syncBuiltinESMExports();
process.on("exit", () => write(3, JSON.stringify(effects)));
`,
);

function run(
  tool: Tool,
  args: string[],
  env: Record<string, string> = {},
  pureMain = false,
): Result {
  const cli = join(ROOT, "bin", `${tool}.mjs`);
  const entry = pureMain
    ? [
        "--input-type=module",
        "--eval",
        `const {main} = await import(${JSON.stringify(pathToFileURL(cli).href)}); process.exitCode = await main(${JSON.stringify(args)});`,
      ]
    : [cli, ...args];
  const child = spawnSync(
    process.execPath,
    ["--import", guard, "--import", "./bin/ts-hook.mjs", ...entry],
    {
      cwd: ROOT,
      encoding: "utf8",
      // Deliberately do not inherit service credentials, DB URLs or NODE_OPTIONS.
      env: { PATH: process.env.PATH, HOME: DIR, ...env },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(
    child.error,
    "subprocess must start and finish, not fail from missing dependencies",
  ).toBeUndefined();
  expect(child.signal).toBeNull();
  const effects = JSON.parse(String(child.output[3])) as Result["effects"];
  expect(effects.network, "offline tools must not even attempt network access").toBe(0);
  expect(effects.writes, "read-only tools must not even attempt file mutation").toBe(0);
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, effects };
}

function file(name: string, content: unknown): string {
  const path = join(DIR, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function fixtures(marker: string) {
  return {
    marker,
    good: file(`${marker}-good.json`, [A]),
    missing: join(DIR, `${marker}-missing.json`),
    malformed: file(`${marker}-malformed.json`, `["${marker}"`),
    wrongIds: file(`${marker}-wrong-ids.json`, [marker]),
    wrongElements: file(`${marker}-wrong-elements.json`, [42, { [marker]: marker }]),
    large: file(`${marker}-large.txt`, marker.repeat(100_000)),
    config: file(`${marker}-config.jsonc`, { vars: {}, env: { fixture: { vars: {} } } }),
    wrongRoles: file(`${marker}-roles.jsonc`, {
      vars: { DISCORD_MODERATOR_ROLE_IDS: { [marker]: marker } },
    }),
    wrongGuild: file(`${marker}-guild.jsonc`, { vars: { DISCORD_GUILD_ID: { [marker]: marker } } }),
    wrongNamedRoles: file(`${marker}-named-roles.jsonc`, {
      env: { fixture: { vars: { DISCORD_MODERATOR_ROLE_IDS: [marker] } } },
    }),
    wrongNamedGuild: file(`${marker}-named-guild.jsonc`, {
      env: { fixture: { vars: { DISCORD_GUILD_ID: [marker] } } },
    }),
  };
}
type Fixtures = ReturnType<typeof fixtures>;
const variants = MARKERS.map(fixtures);
const first = variants[0]!;
const goodAudit = (f: Fixtures) => [`--discord-file=${f.good}`, `--app-file=${f.good}`];

type RefusalCase = { name: string; tool: Tool; args: (f: Fixtures) => string[] };
const refusalCases: RefusalCase[] = [
  ...TOOL_IDS.flatMap((tool) => [
    {
      name: "unknown option with quotes and a forged output line",
      tool,
      args: (f: Fixtures) => [`--unknown=${f.marker}\"\nFORGED_OUTPUT_LINE`],
    },
    { name: "positional input", tool, args: (f: Fixtures) => [f.marker] },
    { name: "no invented dry-run mode", tool, args: () => ["--dry-run"] },
    { name: "no invented replay mode", tool, args: (f: Fixtures) => [`--replay-id=${f.marker}`] },
  ]),
  { name: "empty config path", tool: "check-moderators", args: () => ["--config="] },
  {
    name: "two config paths",
    tool: "check-moderators",
    args: (f) => [`--config=${f.config}`, `--config=${f.missing}`],
  },
  {
    name: "identical duplicate config flags",
    tool: "check-moderators",
    args: (f) => [`--config=${f.config}`, `--config=${f.config}`],
  },
  {
    name: "named environment without config",
    tool: "check-moderators",
    args: (f) => [`--env=${f.marker}`],
  },
  {
    name: "empty named environment",
    tool: "check-moderators",
    args: (f) => [`--config=${f.config}`, "--env="],
  },
  {
    name: "two named environments",
    tool: "check-moderators",
    args: (f) => [`--config=${f.config}`, `--env=${f.marker}`, "--env=fixture"],
  },
  {
    name: "identical duplicate named environment flags",
    tool: "check-moderators",
    args: (f) => [`--config=${f.config}`, "--env=fixture", "--env=fixture"],
  },
  {
    name: "unknown named environment",
    tool: "check-moderators",
    args: (f) => [`--config=${f.config}`, `--env=${f.marker}`],
  },
  {
    name: "unreadable config path",
    tool: "check-moderators",
    args: (f) => [`--config=${f.missing}`],
  },
  {
    name: "directory instead of config",
    tool: "check-moderators",
    args: () => [`--config=${DIR}`],
  },
  { name: "malformed config", tool: "check-moderators", args: (f) => [`--config=${f.malformed}`] },
  {
    name: "non-string moderator var",
    tool: "check-moderators",
    args: (f) => [`--config=${f.wrongRoles}`],
  },
  {
    name: "non-string guild var",
    tool: "check-moderators",
    args: (f) => [`--config=${f.wrongGuild}`],
  },
  {
    name: "non-string named moderator var",
    tool: "check-moderators",
    args: (f) => [`--config=${f.wrongNamedRoles}`, "--env=fixture"],
  },
  {
    name: "non-string named guild var",
    tool: "check-moderators",
    args: (f) => [`--config=${f.wrongNamedGuild}`, "--env=fixture"],
  },
  { name: "neither comparison source", tool: "role-audit", args: () => [] },
  { name: "missing app source", tool: "role-audit", args: (f) => [`--discord-file=${f.good}`] },
  { name: "missing discord source", tool: "role-audit", args: (f) => [`--app-file=${f.good}`] },
  ...(["discord", "app"] as const).flatMap((side): RefusalCase[] => [
    {
      name: `${side} conflicting sources`,
      tool: "role-audit",
      args: (f) => [...goodAudit(f), `--${side}-ids=${A}`],
    },
    {
      name: `${side} duplicate file flags`,
      tool: "role-audit",
      args: (f) => [...goodAudit(f), `--${side}-file=${f.good}`],
    },
    {
      name: `${side} duplicate CSV flags`,
      tool: "role-audit",
      args: () => [`--discord-ids=${A}`, `--app-ids=${A}`, `--${side}-ids=${A}`],
    },
    {
      name: `${side} empty source flag`,
      tool: "role-audit",
      args: (f) => [
        `--${side}-file=`,
        `--${side === "discord" ? "app" : "discord"}-file=${f.good}`,
      ],
    },
    ...(["missing", "malformed", "wrongIds", "wrongElements", "large"] as const).map(
      (kind): RefusalCase => ({
        name: `${side} ${kind} input file`,
        tool: "role-audit",
        args: (f) => [
          `--${side}-file=${f[kind]}`,
          `--${side === "discord" ? "app" : "discord"}-file=${f.good}`,
        ],
      }),
    ),
    {
      name: `${side} malformed inline IDs`,
      tool: "role-audit",
      args: (f) => [
        `--${side}-ids=${f.marker}`,
        `--${side === "discord" ? "app" : "discord"}-ids=${A}`,
      ],
    },
  ]),
  {
    name: "directory instead of ID file",
    tool: "role-audit",
    args: (f) => [`--discord-file=${DIR}`, `--app-file=${f.good}`],
  },
];

function assertSafe(result: Result) {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim().length).toBeGreaterThan(0);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
  for (const marker of [...MARKERS, DIR, "FORGED_OUTPUT_LINE"]) {
    expect(result.stdout).not.toContain(marker);
    expect(result.stderr).not.toContain(marker);
  }
  expect(result.stderr).not.toMatch(/ENOENT|EISDIR|SyntaxError|Unexpected token|at file:\/\//);
}

function assertError(result: Result, tool: Tool) {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  // Parsing the entire stream rejects prose, multiple documents and trailers.
  const error = JSON.parse(result.stderr);
  expect(Object.keys(error).sort()).toEqual([
    "code",
    "message",
    "mode",
    "next_action",
    "ok",
    "retryable",
    "schema",
    "tool",
  ]);
  expect(error).toMatchObject({
    schema: "operator-probe-error.v1",
    tool,
    mode: "error",
    ok: false,
    retryable: false,
  });
  expect(error.code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
  expect(error.code.length).toBeLessThanOrEqual(64);
  for (const value of [error.message, error.next_action]) {
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThanOrEqual(12);
    expect(value.length).toBeLessThanOrEqual(240);
    expect(value).not.toMatch(/[\x00-\x1f\x7f]/);
  }
  expect(error.next_action).not.toMatch(/^(retry|try again)[.!]?$/i);
  return error;
}

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("operator refusal acceptance: confidentiality and machine failures", () => {
  for (const scenario of refusalCases) {
    it(`${scenario.tool}: ${scenario.name}: human refusal is static, bounded and safe`, () => {
      const results = variants.map((f) => run(scenario.tool, scenario.args(f)));
      for (const result of results) assertSafe(result);
      expect(results[0]!.stderr).toBe(results[1]!.stderr);
    });
    it(`${scenario.tool}: ${scenario.name}: --json is one versioned actionable stderr error`, () => {
      const results = variants.map((f, index) =>
        run(
          scenario.tool,
          index === 0 ? ["--json", ...scenario.args(f)] : [...scenario.args(f), "--json"],
        ),
      );
      const errors = results.map((result) => assertError(result, scenario.tool));
      for (const result of results) assertSafe(result);
      expect(errors[0]).toEqual(errors[1]);
    });
  }

  it("role-audit exported main obeys the same refusal contract as its CLI", () => {
    const args = ["--json", `--unknown=${first.marker}`];
    const direct = run("role-audit", args, {}, true);
    const cli = run("role-audit", args);
    assertSafe(direct);
    expect(assertError(direct, "role-audit")).toEqual(assertError(cli, "role-audit"));
  });
});

describe("operator error recovery actions", () => {
  const actions: { tool: Tool; args: string[]; recovery: RegExp }[] = [
    { tool: "check-moderators", args: [`--unknown=${first.marker}`], recovery: /--help/ },
    { tool: "check-moderators", args: [`--config=${first.missing}`], recovery: /--config/ },
    {
      tool: "check-moderators",
      args: [`--config=${first.config}`, `--env=${first.marker}`],
      recovery: /--env/,
    },
    { tool: "role-audit", args: [`--unknown=${first.marker}`], recovery: /--help/ },
    { tool: "role-audit", args: [`--discord-file=${first.good}`], recovery: /--app-(file|ids)/ },
    {
      tool: "role-audit",
      args: [...goodAudit(first), `--discord-ids=${A}`],
      recovery: /--discord-(file|ids)/,
    },
    {
      tool: "role-audit",
      args: [`--discord-ids=${first.marker}`, `--app-ids=${A}`],
      recovery: /--discord-(file|ids)/,
    },
  ];
  it.each(actions)("$tool provides a repair action for $args", ({ tool, args, recovery }) => {
    const result = run(tool, [...args, "--json"]);
    const error = assertError(result, tool);
    assertSafe(result);
    expect(error.next_action).toMatch(recovery);
  });
});

describe("operator probe preservation controls", () => {
  it("offline tripwires count attempted effects even if exceptions are swallowed", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        guard,
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
assert.throws(() => fetch("https://fixture.invalid"), /offline acceptance tripwire/);
assert.throws(() => writeFileSync(${JSON.stringify(join(DIR, "must-not-exist"))}, "fixture"), /offline acceptance tripwire/);`,
      ],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH, HOME: DIR },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        timeout: 10_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
    expect(JSON.parse(String(child.output[3]))).toEqual({ network: 1, writes: 1, reads: 0 });
  });
  it.each(TOOL_IDS)("%s: help takes precedence, reads no input and stays bounded", (tool) => {
    const result = run(tool, [
      "--help",
      "--json",
      `--unknown=${first.marker}`,
      `--config=${first.missing}`,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(3072);
    expect(result.stdout).not.toContain(first.marker);
    expect(result.effects.reads).toBe(0);
  });

  it("both help outputs link the same existing compact repository contract", () => {
    const links = TOOL_IDS.map((tool) => {
      const result = run(tool, ["--help"]);
      expect(result.status).toBe(0);
      const paths: string[] = result.stdout.match(/docs\/[a-z0-9/-]+\.md/gi) || [];
      expect(paths.length).toBeGreaterThan(0);
      return paths;
    });
    const shared = links[0]!.filter((path) => links[1]!.includes(path));
    expect(shared.length).toBe(1);
    const contract = readFileSync(join(ROOT, shared[0]!), "utf8");
    expect(Buffer.byteLength(contract)).toBeLessThanOrEqual(12_288);
  });

  it("role-audit match, deduplication and drift keep the existing JSON document and exits", () => {
    const clean = run("role-audit", [
      `--discord-ids=${B},${A},${A}`,
      `--app-ids=${A},${B}`,
      "--json",
    ]);
    expect(clean.status).toBe(0);
    expect(clean.stderr).toBe("");
    expect(JSON.parse(clean.stdout)).toEqual({
      ok: true,
      discordCount: 2,
      appCount: 2,
      discordOnly: { shown: [], omitted: 0 },
      appOnly: { shown: [], omitted: 0 },
    });
    const drift = run("role-audit", [`--discord-ids=${A}`, `--app-ids=${B}`, "--json"]);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toBe("");
    expect(JSON.parse(drift.stdout)).toEqual({
      ok: false,
      discordCount: 1,
      appCount: 1,
      discordOnly: { shown: [A], omitted: 0 },
      appOnly: { shown: [B], omitted: 0 },
    });
  });

  it("role-audit human success is byte-identical and main matches the CLI", () => {
    const args = [`--discord-ids=${A}`, `--app-ids=${A}`];
    const expected =
      "moderator role audit: Discord set vs app set\n  discord moderators: 1\n  app moderators: 1\n  discord-only (no live app session; panel at next login): 0\n  (none)\n  app-only (excess privilege): 0\n  (none)\n\n  CLEAN: the sets match (empty-safe: no moderators on either side is a clean pass).\n  Read-only: no roles were changed by this check.\n";
    for (const pureMain of [false, true]) {
      const result = run("role-audit", args, {}, pureMain);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(expected);
    }
  });

  it("role-audit real files remain byte-identical; blank files are empty-safe", () => {
    const before = readFileSync(first.good);
    const clean = run("role-audit", [...goodAudit(first), "--json"]);
    expect(clean.status).toBe(0);
    expect(clean.effects.reads).toBe(2);
    expect(readFileSync(first.good)).toEqual(before);
    const blank = file("blank.txt", "");
    expect(run("role-audit", [`--discord-file=${blank}`, `--app-file=${blank}`]).status).toBe(0);
    expect(run("role-audit", [`--discord-file=${first.good}`, `--app-file=${blank}`]).status).toBe(
      1,
    );
  });

  it("role-audit large drift preserves exact totals and bounded shown/omitted lists", () => {
    const ids = Array.from({ length: 105 }, (_, i) => String(200000000000000000n + BigInt(i)));
    const discord = file("large-drift.json", ids);
    const empty = file("empty-ids.json", []);
    const result = run("role-audit", [
      `--discord-file=${discord}`,
      `--app-file=${empty}`,
      "--json",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const verdict = JSON.parse(result.stdout);
    expect(verdict.discordCount).toBe(105);
    expect(verdict.appCount).toBe(0);
    expect(verdict.discordOnly.shown).toEqual(ids.slice(0, 20));
    expect(verdict.discordOnly.omitted).toBe(85);
    expect(verdict.appOnly).toEqual({ shown: [], omitted: 0 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(4096);
  });

  it("check-moderators blank local config still exits 0; require-configured is a verdict exit 1", () => {
    const clean = run("check-moderators", ["--json"]);
    expect(clean.status).toBe(0);
    expect(clean.stderr).toBe("");
    const verdict = JSON.parse(clean.stdout);
    expect(Object.keys(verdict).sort()).toEqual(["failures", "ok", "results", "unknowns"]);
    expect(verdict).toMatchObject({ ok: true, failures: 0, unknowns: 2 });
    expect(
      verdict.results.map((r: { name: string; status: string }) => [r.name, r.status]),
    ).toEqual([
      ["configured", "PASS"],
      ["no-doomed-roles", "PASS"],
      ["is-approved", "UNKNOWN"],
      ["shape", "UNKNOWN"],
      ["fails-closed", "PASS"],
    ]);
    const required = run("check-moderators", ["--json", "--require-configured"]);
    expect(required.status).toBe(1);
    expect(required.stderr).toBe("");
    expect(JSON.parse(required.stdout)).toMatchObject({ ok: false, failures: 1, unknowns: 2 });
  });

  it("check-moderators human success bytes do not change", () => {
    const result = run("check-moderators", []);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(createHash("sha256").update(result.stdout).digest("hex")).toBe(
      "96d8f411af6aa6aad3403adccca3d762ad26ea228b2aaaaeea9e7178e4f4d780",
    );
  });

  it("check-moderators file guild binding is preserved and named vars never fall back", () => {
    const config = file("binding.jsonc", {
      vars: { DISCORD_MODERATOR_ROLE_IDS: PRODUCTION_ROLES, DISCORD_GUILD_ID: PRODUCTION_GUILD },
      env: { fixture: { vars: {} } },
    });
    const args = [`--config=${config}`, "--require-configured", "--json"];
    const bound = run("check-moderators", args);
    expect(bound.status).toBe(0);
    expect(bound.stderr).toBe("");
    expect(bound.effects.reads).toBe(1);
    expect(JSON.parse(bound.stdout).results).toContainEqual(
      expect.objectContaining({ name: "guild-binding", status: "PASS" }),
    );
    const named = run("check-moderators", [...args, "--env=fixture"], {
      DISCORD_MODERATOR_ROLE_IDS: PRODUCTION_ROLES,
      DISCORD_GUILD_ID: PRODUCTION_GUILD,
    });
    expect(named.status).toBe(1);
    expect(named.stderr).toBe("");
    expect(JSON.parse(named.stdout).results).toContainEqual(
      expect.objectContaining({ name: "configured", status: "FAIL" }),
    );
    expect(JSON.parse(named.stdout).results).toContainEqual(
      expect.objectContaining({ name: "guild-binding", status: "FAIL" }),
    );
    const wrong = run("check-moderators", ["--json", "--require-configured"], {
      DISCORD_MODERATOR_ROLE_IDS: PRODUCTION_ROLES,
      DISCORD_GUILD_ID: "100000000000000009",
    });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toBe("");
    expect(JSON.parse(wrong.stdout).results).toContainEqual(
      expect.objectContaining({ name: "guild-binding", status: "FAIL" }),
    );
  });
});
