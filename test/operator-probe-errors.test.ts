import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(
  join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(),
    "probe-codes-",
  ),
);
const marker = "SYNTHETIC_PRIVATE_INPUT";
const contract = readFileSync("docs/operator-probes.md", "utf8");
const file = (name: string, content: string) => {
  const path = join(dir, `${marker}-${name}`);
  writeFileSync(path, content);
  return path;
};
const missing = join(dir, `${marker}-missing`);
const empty = file("empty.txt", "");
const malformed = file("bad.json", `["${marker}"`);
const config = file("config.jsonc", '{"env":{"fixture":{"vars":{}}}}');
// Under one million JS characters, but over one million UTF-8 bytes.
const largeIds = file("large.json", JSON.stringify(["é".repeat(500_000)]));
const largeConfig = file("large.jsonc", `/*${"é".repeat(500_000)}*/{}`);

type Tool = "check-moderators" | "role-audit";
function run(tool: Tool, args: string[], pureMain = false) {
  const entry = pureMain
    ? [
        "--input-type=module",
        "--eval",
        `const { main } = await import(${JSON.stringify(pathToFileURL(resolve(`bin/${tool}.mjs`)).href)}); process.exitCode = await main(${JSON.stringify(args)});`,
      ]
    : [`bin/${tool}.mjs`, ...args];
  const result = spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", ...entry], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function refused(tool: Tool, args: string[], code: string) {
  const result = run(tool, [...args, "--json"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  const error = JSON.parse(result.stderr);
  expect(error).toMatchObject({
    schema: "operator-probe-error.v1",
    tool,
    mode: "error",
    ok: false,
    code,
    retryable: false,
  });
  expect(result.stderr).not.toContain(marker);
  expect(result.stderr).not.toContain(dir);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
  expect(contract).toContain(`\`${code}\``);
  return error;
}

const readsGuard = join(dir, `${marker}-reads-guard.mjs`);
writeFileSync(
  readsGuard,
  `import fs from "node:fs";\nimport { syncBuiltinESMExports } from "node:module";\nlet reads = 0;\nconst read = fs.readFileSync.bind(fs);\nfs.readFileSync = (path, ...args) => {\n  if (String(path).startsWith(${JSON.stringify(dir)})) reads++;\n  return read(path, ...args);\n};\nsyncBuiltinESMExports();\nprocess.on("exit", () => fs.writeSync(3, String(reads)));\n`,
);

function runCountReads(tool: Tool, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", readsGuard, "--import", "./bin/ts-hook.mjs", `bin/${tool}.mjs`, ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: dir },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  // Fail closed on a missing report: an empty fd 3 read must never become 0.
  const report = String(result.output[3]);
  expect(report).toMatch(/^\d+$/);
  const reads = Number(report);
  return { result, reads };
}

function runViaSymlink(tool: Tool, args: string[]) {
  const link = join(dir, `${marker}-${tool}-link.mjs`);
  rmSync(link, { force: true });
  symlinkSync(resolve(`bin/${tool}.mjs`), link);
  const result = spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", link, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("operator probe entrypoints and local file types", () => {
  it.each<Tool>(["check-moderators", "role-audit"])(
    "%s main returns the CLI refusal without forcing process exit",
    (tool) => {
      const args = [`--unknown=${marker}`, "--json"];
      const cli = run(tool, args);
      const direct = run(tool, args, true);
      expect(direct.status).toBe(2);
      expect(direct.stdout).toBe("");
      expect(direct.stderr).toBe(cli.stderr);
    },
  );
  it("refuses FIFO and device inputs without blocking on a read", () => {
    const fifo = join(dir, "input.fifo");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5_000 });
    expect(created.error).toBeUndefined();
    expect(created.status).toBe(0);
    for (const path of [fifo, "/dev/null"]) {
      refused("check-moderators", [`--config=${path}`], "CONFIG_UNREADABLE");
      refused(
        "role-audit",
        [`--discord-file=${path}`, `--app-file=${empty}`],
        "DISCORD_FILE_UNREADABLE",
      );
      refused(
        "role-audit",
        [`--discord-file=${empty}`, `--app-file=${path}`],
        "APP_FILE_UNREADABLE",
      );
    }
  });
});

describe("operator probe symlinked entrypoints", () => {
  it.each<Tool>(["check-moderators", "role-audit"])(
    "%s refuses through a symlinked entrypoint instead of exiting 0 silently",
    (tool) => {
      const result = runViaSymlink(tool, [`--unknown=${marker}`, "--json"]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr);
      expect(error).toMatchObject({
        schema: "operator-probe-error.v1",
        tool,
        mode: "error",
        ok: false,
        code: "UNKNOWN_OPTION",
        retryable: false,
      });
      expect(result.stderr).not.toContain(marker);
    },
  );
  it("check-moderators symlinked deploy gate still emits its verdict", () => {
    const result = runViaSymlink("check-moderators", ["--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });
  it("role-audit symlinked drift still exits 1 with its verdict", () => {
    const result = runViaSymlink("role-audit", [
      "--discord-ids=100000000000000001",
      "--app-ids=100000000000000002",
      "--json",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const verdict = JSON.parse(result.stdout);
    expect(verdict).toMatchObject({ ok: false, discordCount: 1, appCount: 1 });
  });
});

describe("role-audit source validation opens no input files", () => {
  it("refuses an ambiguous app source before opening a missing discord file", () => {
    const error = refused(
      "role-audit",
      [`--discord-file=${missing}`, `--app-file=${empty}`, "--app-ids=100000000000000001"],
      "APP_SOURCE_INVALID",
    );
    expect(error.next_action).toContain("--app-");
  });
  it("refuses an ambiguous discord source before opening a missing app file", () => {
    refused(
      "role-audit",
      [`--discord-file=${empty}`, "--discord-ids=100000000000000001", `--app-file=${missing}`],
      "DISCORD_SOURCE_INVALID",
    );
  });
  const ambiguous: [string, string[]][] = [
    [
      "discord conflicting sources",
      [`--discord-file=${empty}`, "--discord-ids=100000000000000001", `--app-file=${empty}`],
    ],
    [
      "app conflicting sources",
      [`--discord-file=${empty}`, `--app-file=${empty}`, "--app-ids=100000000000000001"],
    ],
    [
      "discord duplicate file flags",
      [`--discord-file=${empty}`, `--discord-file=${empty}`, `--app-file=${empty}`],
    ],
    [
      "app duplicate file flags",
      [`--discord-file=${empty}`, `--app-file=${empty}`, `--app-file=${empty}`],
    ],
    [
      "missing discord plus ambiguous app",
      [`--discord-file=${missing}`, `--app-file=${empty}`, "--app-ids=100000000000000001"],
    ],
    [
      "ambiguous discord plus missing app",
      [`--discord-file=${empty}`, "--discord-ids=100000000000000001", `--app-file=${missing}`],
    ],
  ];
  it.each(ambiguous)("conflicting sources open no input files: %s", (_name, args) => {
    const { result, reads } = runCountReads("role-audit", [...args, "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(reads).toBe(0);
  });
  it("read counter observes a valid file source", () => {
    const { result, reads } = runCountReads("role-audit", [
      `--discord-file=${empty}`,
      `--app-file=${empty}`,
      "--json",
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(reads).toBeGreaterThan(0);
  });
});

describe("oversized inputs are refused before reading", () => {
  const oversized: [string, Tool, string[], string][] = [
    [
      "check-moderators --config",
      "check-moderators",
      [`--config=${largeConfig}`],
      "CONFIG_TOO_LARGE",
    ],
    [
      "role-audit discord file",
      "role-audit",
      [`--discord-file=${largeIds}`, `--app-file=${empty}`],
      "DISCORD_INPUT_TOO_LARGE",
    ],
    [
      "role-audit app file",
      "role-audit",
      ["--discord-ids=100000000000000001", `--app-file=${largeIds}`],
      "APP_INPUT_TOO_LARGE",
    ],
  ];
  it.each(oversized)("oversized input opens no input files: %s", (_name, tool, args, code) => {
    const { result, reads } = runCountReads(tool, [...args, "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({
      schema: "operator-probe-error.v1",
      tool,
      mode: "error",
      ok: false,
      code,
      retryable: false,
    });
    expect(reads).toBe(0);
  });
});

describe("documented operator refusal taxonomy", () => {
  it.each<Tool>(["check-moderators", "role-audit"])("%s: shared option codes", (tool) => {
    refused(tool, [`--unknown=${marker}`], "UNKNOWN_OPTION");
    refused(tool, ["--json", "--json"], "DUPLICATE_OPTION");
  });

  const cases: [string, string[]][] = [
    ["CONFIG_SOURCE_INVALID", ["--config="]],
    ["ENV_SOURCE_INVALID", [`--env=${marker}`]],
    ["CONFIG_UNREADABLE", [`--config=${missing}`]],
    ["CONFIG_INVALID", [`--config=${malformed}`]],
    ["CONFIG_TOO_LARGE", [`--config=${largeConfig}`]],
    ["ENV_NOT_FOUND", [`--config=${config}`, `--env=${marker}`]],
    [
      "MODERATOR_VAR_INVALID",
      [`--config=${file("roles.jsonc", '{"vars":{"DISCORD_MODERATOR_ROLE_IDS":false}}')}`],
    ],
    ["GUILD_VAR_INVALID", [`--config=${file("guild.jsonc", '{"vars":{"DISCORD_GUILD_ID":0}}')}`]],
  ];
  it.each(cases)("check-moderators: %s", (code, args) => {
    refused("check-moderators", args, code);
  });

  for (const side of ["discord", "app"] as const) {
    const other = side === "discord" ? "app" : "discord";
    const otherArgs = [`--${other}-file=${empty}`];
    const sideCases: [string, string[]][] = [
      ["SOURCE_INVALID", []],
      ["FILE_UNREADABLE", [`--${side}-file=${missing}`]],
      ["INPUT_TOO_LARGE", [`--${side}-file=${largeIds}`]],
      ["INPUT_INVALID", [`--${side}-file=${malformed}`]],
    ];
    it.each(sideCases)(`role-audit ${side}: %s`, (suffix, args) => {
      const error = refused(
        "role-audit",
        [...args, ...otherArgs],
        `${side.toUpperCase()}_${suffix}`,
      );
      expect(error.next_action).toContain(`--${side}-`);
    });
  }
});

describe("moderator config refusal edges", () => {
  it.each(["null", "[]", "42", '"text"', '{"vars":null}', '{"vars":[]}'])(
    "refuses invalid root/vars shapes: %s",
    (text) => {
      const path = file("shape.jsonc", text);
      refused("check-moderators", [`--config=${path}`], "CONFIG_INVALID");
    },
  );
  it.each(["null", "[]", "42", '"text"'])("refuses invalid named structures: %s", (text) => {
    for (const content of [`{"env":${text}}`, `{"env":{"fixture":${text}}}`]) {
      const path = file("named-shape.jsonc", content);
      refused("check-moderators", [`--config=${path}`, "--env=fixture"], "CONFIG_INVALID");
    }
  });
  it.each(["null", "false", "0", "[]", "{}"])(
    "refuses every present non-string variable before falsey fallback: %s",
    (value) => {
      for (const [key, code] of [
        ["DISCORD_MODERATOR_ROLE_IDS", "MODERATOR_VAR_INVALID"],
        ["DISCORD_GUILD_ID", "GUILD_VAR_INVALID"],
      ] as const) {
        for (const named of [false, true]) {
          const vars = `{"vars":{"${key}":${value}}}`;
          const path = file("var.jsonc", named ? `{"env":{"fixture":${vars}}}` : vars);
          refused(
            "check-moderators",
            [`--config=${path}`, ...(named ? ["--env=fixture"] : [])],
            code,
          );
        }
      }
    },
  );
  it("requires declared own environment keys but permits an explicitly declared prototype-like key", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      refused("check-moderators", [`--config=${config}`, `--env=${name}`], "ENV_NOT_FOUND");
    }
    const path = file("own-key.jsonc", '{"env":{"__proto__":{"vars":{}}}}');
    const result = run("check-moderators", [`--config=${path}`, "--env=__proto__", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });
  it("duplicate require-configured is refused instead of silently deduplicated", () => {
    refused(
      "check-moderators",
      ["--require-configured", "--require-configured"],
      "DUPLICATE_OPTION",
    );
  });
});
