import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSOP_MODERATOR_ROLE_ID as SYSOP } from "../src/probes/check-moderators";

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
  it("routes runners by repo visibility with a job-private container", () => {
    // Self-hosted while private; GitHub-hosted only while public (TOG-12326).
    expect(smoke).toContain(
      `runs-on: \${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || 'ubuntu-latest' }}\n`,
    );
    expect(smoke).toContain("image: node:24-bookworm");
    expect(smoke.split("ubuntu-latest")).toHaveLength(2);
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
