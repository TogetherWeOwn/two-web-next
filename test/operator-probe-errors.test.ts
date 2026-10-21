import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
