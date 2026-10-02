import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSOP_MODERATOR_ROLE_ID as SYSOP } from "../src/probes/check-moderators";
// @ts-expect-error Standalone tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const deploy = read(".github/workflows/deploy.yml");
const smoke = read(".github/workflows/staging-smoke.yml");
const temp = () =>
  mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "probe-fixture-"));

function configProbe(text: string, envRole = SYSOP) {
  const dir = temp();
  try {
    const path = join(dir, "wrangler.jsonc");
    writeFileSync(path, text);
    return spawnSync(
      process.execPath,
      [
        "--import",
        "./bin/ts-hook.mjs",
        "bin/check-moderators.mjs",
        `--config=${path}`,
        "--require-configured",
        "--json",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: envRole },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("source-managed moderator deployment preflight", () => {
  it("validates JSONC vars rather than an unrelated process value", () => {
    const result = configProbe(
      `{ // public role\n "vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}",},}`,
      "SySOp",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ failures: 0, ok: true });
  });

  it.each([
    "{}",
    '{"vars": {}}',
    '{"vars": {"DISCORD_MODERATOR_ROLE_IDS": ""}}',
    '{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "SySOp"}}',
    `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP},100000000000000001"}}`,
    `{"env": {"staging": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}}}}`,
  ])("fails absent/invalid top-level config despite a valid CI value: %s", (text) => {
    const result = configProbe(text);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });

  it.each(['{"vars":', '{"vars": {"DISCORD_MODERATOR_ROLE_IDS": 123}}'])(
    "reports malformed config without echoing it",
    (text) => {
      const result = configProbe(text);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/cannot read a valid Wrangler config/);
    },
  );

  it("reads a named environment with no fallback to the top level", () => {
    const envProbe = (text: string, env: string, extra: string[] = []) => {
      const dir = temp();
      try {
        const path = join(dir, "wrangler.jsonc");
        writeFileSync(path, text);
        return spawnSync(
          process.execPath,
          [
            "--import",
            "./bin/ts-hook.mjs",
            "bin/check-moderators.mjs",
            `--config=${path}`,
            `--env=${env}`,
            "--require-configured",
            "--json",
            ...extra,
          ],
          {
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "SySOp" },
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Production env configured: passes even when the process value is garbage.
    const ok = envProbe(
      `{"vars": {}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}}}}`,
      "production",
    );
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ failures: 0, ok: true });
    // Production env missing the var fails even when the top level has it:
    // Wrangler does not inherit top-level vars, so a fallback would lie.
    const noFallback = envProbe(
      `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}, "env": {"production": {"vars": {}}}}`,
      "production",
    );
    expect(noFallback.status).toBe(1);
    expect(JSON.parse(noFallback.stdout)).toMatchObject({ ok: false });
    // No env block at all: the named env is unknown in that config, so it is
    // a usage error (exit 2), never a probe pass. The deploy step still fails.
    const noEnv = envProbe(`{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}}`, "production");
    expect(noEnv.status).toBe(2);
    expect(noEnv.stdout).toBe("");
    expect(noEnv.stderr).toMatch(/unknown environment/);
    // A wrong production value fails even with a valid top level.
    const wrong = envProbe(
      `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "SySOp"}}}}`,
      "production",
    );
    expect(wrong.status).toBe(1);
    expect(JSON.parse(wrong.stdout)).toMatchObject({ ok: false });
  });

  it("refuses an unknown environment without echoing config", () => {
    const dir = temp();
    try {
      const path = join(dir, "wrangler.jsonc");
      writeFileSync(
        path,
        `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}}}}`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "./bin/ts-hook.mjs",
          "bin/check-moderators.mjs",
          `--config=${path}`,
          "--env=staging",
          "--require-configured",
          "--json",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: SYSOP },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/unknown environment/);
      expect(result.stderr).not.toContain(SYSOP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires --config alongside --env and leaves top-level reads unchanged", () => {
    // --env without --config is a usage error, never a probe result.
    const bare = spawnSync(
      process.execPath,
      [
        "--import",
        "./bin/ts-hook.mjs",
        "bin/check-moderators.mjs",
        "--env=production",
        "--require-configured",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: SYSOP },
      },
    );
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/--env=<name> requires/);
    // Empty --env value is the same usage error.
    const empty = spawnSync(
      process.execPath,
      [
        "--import",
        "./bin/ts-hook.mjs",
        "bin/check-moderators.mjs",
        "--config=wrangler.jsonc",
        "--env=",
        "--require-configured",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: SYSOP },
      },
    );
    expect(empty.status).toBe(2);
    // Top-level behaviour is unchanged: --config without --env still reads
    // top-level vars and ignores named environments.
    const dir = temp();
    try {
      const path = join(dir, "wrangler.jsonc");
      writeFileSync(
        path,
        `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "SySOp"}}}}`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "./bin/ts-hook.mjs",
          "bin/check-moderators.mjs",
          `--config=${path}`,
          "--require-configured",
          "--json",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "SySOp" },
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ failures: 0, ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates production on the production-env moderator value before any deploy", () => {
    const production = read(".github/workflows/deploy-production.yml");
    const prodScripts = JSON.parse(read("package.json")).scripts;
    expect(prodScripts["check:worker-moderators-production"]).toContain(
      "--config=wrangler.jsonc --env=production --require-configured",
    );
    expect(production).toContain("run: npm run check:worker-moderators-production");
    // The moderator preflight runs after the credentials check and before
    // the first Cloudflare mutation (shared step order: gate → dry-run →
    // credentials → moderator preflight → deploy → /up smoke).
    const prodGate = production.indexOf("run: npm run check:worker-moderators-production");
    expect(prodGate).toBeGreaterThan(-1);
    expect(prodGate).toBeGreaterThan(
      production.indexOf("run: node ci/production-deploy-gate.mjs --credentials"),
    );
    expect(prodGate).toBeLessThan(production.indexOf("run: npx wrangler deploy --env production"));
    expect(production).not.toContain("secrets.DISCORD_MODERATOR_ROLE_IDS");
    // env.production declares the same approved SySOp role; Wrangler does not
    // inherit top-level vars, so this entry is the one production boots with.
    const parsed = readWranglerConfig(read("wrangler.jsonc"));
    expect(parsed.env?.production?.vars?.DISCORD_MODERATOR_ROLE_IDS).toBe(SYSOP);
    expect(parsed.vars?.DISCORD_MODERATOR_ROLE_IDS).toBe(SYSOP);
  });

  it("checks the same explicit source config before all Cloudflare mutations", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["check:worker-moderators"]).toContain(
      "--config=wrangler.jsonc --require-configured",
    );
    expect(deploy).toContain("run: npx wrangler deploy --config wrangler.jsonc\n");
    const gate = deploy.indexOf("run: npm run check:worker-moderators");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(deploy.indexOf("npx wrangler queues create"));
    expect(gate).toBeLessThan(deploy.indexOf("run: npx wrangler deploy"));
    expect(deploy).not.toContain("secrets.DISCORD_MODERATOR_ROLE_IDS");
    expect(smoke).toContain("run: npm run check:worker-moderators");
    // This checks only source declarations, not current vendor isolation/bindings.
    expect(read("wrangler.jsonc")).toContain(`"DISCORD_MODERATOR_ROLE_IDS": "${SYSOP}"`);
    expect(read("wrangler.jsonc")).toContain('"keep_vars": true');
  });
});

describe("staging smoke workflow safety", () => {
  it("uses approved self-hosted labels with a job-private container", () => {
    expect(smoke).toContain("runs-on: [self-hosted, two-selfhosted]");
    expect(smoke).toContain("image: node:24-bookworm");
    expect(smoke).not.toContain("ubuntu-latest");
  });

  it("matches the documented vars/secrets namespaces", () => {
    expect(smoke).toContain("BOT_KEY_ID: ${{ vars.BOT_KEY_ID }}");
    expect(smoke).toContain("BOT_PRODUCTION_URL: ${{ vars.BOT_PRODUCTION_URL }}");
    expect(smoke).toContain("BOT_SHARED_SECRET: ${{ secrets.BOT_SHARED_SECRET }}");
    expect(smoke).toContain("BOT_ENDPOINT_URL: ${{ secrets.BOT_ENDPOINT_URL }}");
  });

  it("passes metacharacters as inert arguments through the actual workflow shell", () => {
    const script = smoke
      .split("        run: >-\n")[1]
      ?.split("        env:\n")[0]
      ?.trim()
      .replace(/\n\s+/g, " ");
    expect(script).toBeTruthy();
    expect(script).not.toContain("${{ inputs.");
    for (const [env, input] of [
      ["SMOKE_DISCORD_ID", "discord_id"],
      ["SMOKE_ROLE_KEY", "role_key"],
      ["SMOKE_CHANNEL_KEY", "channel_key"],
    ]) {
      expect(smoke).toContain(`${env}: \${{ inputs.${input} }}`);
    }
    const dir = temp();
    try {
      // Fake npm captures argv; no CLI request, credential or external service.
      writeFileSync(
        join(dir, "npm"),
        "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
        { mode: 0o755 },
      );
      const values = [
        "$(printf HARMLESS_SUBSTITUTION_MARKER)",
        'r"; printf HARMLESS_BREAKOUT; #',
        "`printf HARMLESS_BACKTICK` * ; $HOME",
      ];
      const result = spawnSync("/bin/sh", ["-c", script!], {
        encoding: "utf8",
        timeout: 3000,
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          SMOKE_DISCORD_ID: values[0],
          SMOKE_ROLE_KEY: values[1],
          SMOKE_CHANNEL_KEY: values[2],
        },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual([
        "run",
        "smoke:internal-action",
        "--",
        `--discord-id=${values[0]}`,
        `--role-key=${values[1]}`,
        `--channel-key=${values[2]}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
