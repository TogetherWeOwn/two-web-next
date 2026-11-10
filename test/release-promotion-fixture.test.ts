import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("isolates every setup and helper Git call without replacing the inherited launcher PATH", ({
  onTestFinished,
}) => {
  const parent = mkdtempSync(join(tmpdir(), "release-git-parent-"));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const config = join(parent, ".gitconfig");
  writeFileSync(config, "[user]\nname = Parent\n[commit]\ngpgSign = true\n");
  for (const [key, value] of Object.entries({
    HOME: parent,
    XDG_CONFIG_HOME: parent,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Injected parent",
    GIT_AUTHOR_NAME: "Parent author",
    GIT_COMMITTER_NAME: "Parent committer",
    GH_TOKEN: "fixture-only-sentinel",
    PAPERCLIP_GITHUB_BROKER_TOKEN: "fixture-only-sentinel",
    DATABASE_URL: "fixture-only-sentinel",
    NODE_OPTIONS: "--invalid-fixture-parent-option",
  })) {
    vi.stubEnv(key, value);
  }
  const inheritedPath = process.env.PATH;
  const execute = childProcess.execFileSync;
  let calls = 0;
  const spy = vi.spyOn(childProcess, "execFileSync").mockImplementation((file, args, options) => {
    expect(file).toBe("git");
    expect(args?.slice(0, 6)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "core.hooksPath=/dev/null",
    ]);
    expect(options).toHaveProperty("env");
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(env.PATH).toBe(inheritedPath);
    expect(env.HOME).not.toBe(parent);
    expect(env.HOME).toBe(env.TMPDIR);
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "TMPDIR",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
      ].sort(),
    );
    calls += 1;
    return execute(file, args, options);
  });
  const { fixture } = require("../ci/release-promotion-proof.fixture.cjs") as {
    fixture: (t: { after: typeof onTestFinished }) => {
      root: string;
      git: (...args: string[]) => string;
      commit: (subject: string) => string;
    };
  };
  const f = fixture({ after: onTestFinished });
  expect(calls).toBeGreaterThan(10);
  const setupCalls = calls;
  expect(f.git("log", "-1", "--format=%an <%ae> / %cn <%ce>")).toBe(
    "Fixture <fixture@example.invalid> / Fixture <fixture@example.invalid>",
  );
  expect(f.git("config", "--get", "user.name")).toBe("Fixture");
  expect(f.git("config", "--get", "user.email")).toBe("fixture@example.invalid");
  const sha = f.commit("fix: isolated helper control");
  expect(f.git("rev-parse", "refs/remotes/origin/main")).toBe(sha);
  expect(calls).toBe(setupCalls + 7);
  expect(spy.mock.calls.every(([, , options]) => options?.env?.HOME === f.root)).toBe(true);
});
