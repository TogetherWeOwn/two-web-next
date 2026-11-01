import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_MODERATOR_ROLE_IDS,
  PRODUCTION_GUILD_ID,
  STAGING_GUILD_ID,
  STAGING_MODERATOR_ROLE_IDS,
} from "../src/probes/check-moderators";
const APPROVED = APPROVED_MODERATOR_ROLE_IDS.join(",");
const STAGING = STAGING_MODERATOR_ROLE_IDS.join(",");
// @ts-expect-error Standalone tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const deploy = read(".github/workflows/deploy.yml");
const smoke = read(".github/workflows/staging-smoke.yml");
const temp = () =>
  mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "probe-fixture-"));

function configProbe(text: string, envRole = APPROVED) {
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
      `{ // public role\n "vars": {"DISCORD_GUILD_ID": "${PRODUCTION_GUILD_ID}", "DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}",},}`,
      "Moderator",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ failures: 0, ok: true });
  });

  it.each([
    `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}`,
    '{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "1546777855801954408,1546777856984481792"}}',
    `{"vars": {"DISCORD_GUILD_ID": "", "DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}`,
  ])("fails a config-file read with a missing or blank guild: %s", (text) => {
    const result = configProbe(text);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      results: { name: string; status: string }[];
    };
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.results.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
  });

  it.each([
    "{}",
    '{"vars": {}}',
    '{"vars": {"DISCORD_MODERATOR_ROLE_IDS": ""}}',
    '{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "Moderator"}}',
    `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED},100000000000000001"}}`,
    `{"env": {"staging": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}}}`,
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
            env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "Moderator" },
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Production env configured: passes even when the process value is garbage.
    const ok = envProbe(
      `{"vars": {}, "env": {"production": {"vars": {"DISCORD_GUILD_ID": "${PRODUCTION_GUILD_ID}", "DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}}}`,
      "production",
    );
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ failures: 0, ok: true });
    // Named env without a guild fails the binding instead of falling back to
    // the legacy production-pair expectation with no guild-binding finding.
    const noGuild = envProbe(
      `{"vars": {}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}}}`,
      "production",
    );
    expect(noGuild.status).toBe(1);
    const noGuildFindings = JSON.parse(noGuild.stdout).results as {
      name: string;
      status: string;
    }[];
    expect(noGuildFindings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
    // Production env missing the var fails even when the top level has it:
    // Wrangler does not inherit top-level vars, so a fallback would lie.
    const noFallback = envProbe(
      `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}, "env": {"production": {"vars": {}}}}`,
      "production",
    );
    expect(noFallback.status).toBe(1);
    expect(JSON.parse(noFallback.stdout)).toMatchObject({ ok: false });
    // No env block at all: the named env is unknown in that config, so it is
    // a usage error (exit 2), never a probe pass. The deploy step still fails.
    const noEnv = envProbe(`{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}`, "production");
    expect(noEnv.status).toBe(2);
    expect(noEnv.stdout).toBe("");
    expect(noEnv.stderr).toMatch(/unknown environment/);
    // A wrong production value fails even with a valid top level.
    const wrong = envProbe(
      `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "Moderator"}}}}`,
      "production",
    );
    expect(wrong.status).toBe(1);
    expect(JSON.parse(wrong.stdout)).toMatchObject({ ok: false });
  });

  it("binds each config to its own guild: a production pair in a staging guild fails", () => {
    const guildProbe = (vars: string) => {
      const dir = temp();
      try {
        const path = join(dir, "wrangler.jsonc");
        writeFileSync(path, `{"vars": {${vars}}}`);
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
            env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "Moderator" },
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const vars = (guild: string, roles: string) =>
      `"DISCORD_GUILD_ID": "${guild}", "DISCORD_MODERATOR_ROLE_IDS": "${roles}"`;
    // Staging pair in the staging guild: the pre-2026-10-14 mismatch, fixed.
    const staging = guildProbe(vars(STAGING_GUILD_ID, STAGING));
    expect(staging.status).toBe(0);
    expect(JSON.parse(staging.stdout)).toMatchObject({ failures: 0, ok: true });
    // Production pair in the staging guild: every role finding can pass while
    // the grant matches nobody. The binding finding must fail the run.
    const mismatched = guildProbe(vars(STAGING_GUILD_ID, APPROVED));
    expect(mismatched.status).toBe(1);
    const findings = JSON.parse(mismatched.stdout).results as { name: string; status: string }[];
    expect(findings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
    // The --env=production branch reads its own guild: the same mismatches
    // through --env must fail, pinning the production gate's guild read.
    const envGuildProbe = (guild: string, roles: string) => {
      const dir = temp();
      try {
        const path = join(dir, "wrangler.jsonc");
        writeFileSync(
          path,
          `{"vars": {${vars(STAGING_GUILD_ID, STAGING)}}, "env": {"production": {"vars": {${vars(guild, roles)}}}}}`,
        );
        return spawnSync(
          process.execPath,
          [
            "--import",
            "./bin/ts-hook.mjs",
            "bin/check-moderators.mjs",
            `--config=${path}`,
            "--env=production",
            "--require-configured",
            "--json",
          ],
          {
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "Moderator" },
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Staging guild carrying the production pair: fails the binding.
    const envMismatched = envGuildProbe(STAGING_GUILD_ID, APPROVED);
    expect(envMismatched.status).toBe(1);
    const envFindings = JSON.parse(envMismatched.stdout).results as {
      name: string;
      status: string;
    }[];
    expect(envFindings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
    // Mirror: production guild carrying the staging pair fails too.
    const envMirrored = envGuildProbe(PRODUCTION_GUILD_ID, STAGING);
    expect(envMirrored.status).toBe(1);
    const mirroredFindings = JSON.parse(envMirrored.stdout).results as {
      name: string;
      status: string;
    }[];
    expect(mirroredFindings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
    // The shipped configs are guild-bound both ways: top level is the
    // staging deploy, env.production is production.
    for (const extra of [[], ["--env=production"]]) {
      const shipped = spawnSync(
        process.execPath,
        [
          "--import",
          "./bin/ts-hook.mjs",
          "bin/check-moderators.mjs",
          "--config=wrangler.jsonc",
          ...extra,
          "--require-configured",
          "--json",
        ],
        { encoding: "utf8", timeout: 30_000, env: { ...process.env } },
      );
      expect(shipped.status).toBe(0);
      expect(JSON.parse(shipped.stdout)).toMatchObject({ failures: 0, ok: true });
    }
  });

  it("refuses an unknown environment without echoing config", () => {
    const dir = temp();
    try {
      const path = join(dir, "wrangler.jsonc");
      writeFileSync(
        path,
        `{"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}}}}`,
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
          env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: APPROVED },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/unknown environment/);
      expect(result.stderr).not.toContain(APPROVED);
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
        env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: APPROVED },
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
        env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: APPROVED },
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
        `{"vars": {"DISCORD_GUILD_ID": "${PRODUCTION_GUILD_ID}", "DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"}, "env": {"production": {"vars": {"DISCORD_MODERATOR_ROLE_IDS": "Moderator"}}}}`,
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
          env: { ...process.env, DISCORD_MODERATOR_ROLE_IDS: "Moderator" },
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
    // credentials → moderator preflight → version upload/deploy → public-route smoke).
    const prodGate = production.indexOf("run: npm run check:worker-moderators-production");
    expect(prodGate).toBeGreaterThan(-1);
    expect(prodGate).toBeGreaterThan(
      production.indexOf("run: node ci/production-deploy-gate.mjs --credentials"),
    );
    expect(prodGate).toBeLessThan(
      production.indexOf("npx wrangler versions upload --env production"),
    );
    expect(production).not.toContain("secrets.DISCORD_MODERATOR_ROLE_IDS");
    // env.production declares the production approved Owner+Moderator pair;
    // Wrangler does not inherit top-level vars, so this entry is the one
    // production boots with. The deployed Kit staging config carries the
    // staging-guild pair, never the production one (role IDs are guild-scoped).
    const parsed = readWranglerConfig(read("wrangler.jsonc"));
    const stagingKit = readWranglerConfig(read("web/wrangler.staging.jsonc"));
    expect(parsed.env?.production?.vars?.DISCORD_MODERATOR_ROLE_IDS).toBe(APPROVED);
    expect(parsed.env?.production?.vars?.DISCORD_GUILD_ID).toBe(PRODUCTION_GUILD_ID);
    expect(parsed.vars?.DISCORD_MODERATOR_ROLE_IDS).toBe(STAGING);
    expect(parsed.vars?.DISCORD_GUILD_ID).toBe(STAGING_GUILD_ID);
    expect(stagingKit.vars?.DISCORD_MODERATOR_ROLE_IDS).toBe(STAGING);
    expect(stagingKit.vars?.DISCORD_GUILD_ID).toBe(STAGING_GUILD_ID);
  });

  it("checks the same explicit source config before all Cloudflare mutations", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["check:worker-moderators"]).toContain(
      "--config=web/wrangler.staging.jsonc --require-configured",
    );
    expect(deploy).toContain(
      'run: npx wrangler deploy --config web/wrangler.staging.jsonc --tag "${DEPLOY_SHA:?}"',
    );
    const gate = deploy.indexOf("run: npm run check:worker-moderators");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(deploy.indexOf("npx wrangler queues create"));
    expect(gate).toBeLessThan(deploy.indexOf("run: npx wrangler deploy"));
    expect(deploy).not.toContain("secrets.DISCORD_MODERATOR_ROLE_IDS");
    expect(smoke).toContain("run: npm run check:worker-moderators");
    // This checks only source declarations, not current vendor isolation/bindings.
    // Production keeps the production pair; the top-level staging deploy
    // carries the staging-guild pair (guild binding is asserted below).
    expect(read("wrangler.jsonc")).toContain(`"DISCORD_MODERATOR_ROLE_IDS": "${APPROVED}"`);
    expect(read("wrangler.jsonc")).toContain(`"DISCORD_MODERATOR_ROLE_IDS": "${STAGING}"`);
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
    const block = smoke.split("        run: |\n")[1]?.split("        env:\n")[0];
    expect(block).toBeTruthy();
    // Dedent only; newlines must survive so the if/else keeps its shape.
    const script = block!.replace(/^ {10}/gm, "").trim();
    expect(script).not.toContain("${{ inputs.");
    for (const [env, input] of [
      ["SMOKE_ANNOUNCEMENT_ONLY", "announcement_only"],
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
      const run = (announcementOnly: string | undefined) =>
        spawnSync("/bin/sh", ["-c", script], {
          encoding: "utf8",
          timeout: 3000,
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            ...(announcementOnly === undefined
              ? {}
              : { SMOKE_ANNOUNCEMENT_ONLY: announcementOnly }),
            SMOKE_DISCORD_ID: values[0],
            SMOKE_ROLE_KEY: values[1],
            SMOKE_CHANNEL_KEY: values[2],
          },
        });
      // Unset (older dispatches) and "false" both take the full-smoke branch.
      for (const flag of [undefined, "false"]) {
        const result = run(flag);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual([
          "run",
          "smoke:internal-action",
          "--",
          `--discord-id=${values[0]}`,
          `--role-key=${values[1]}`,
          `--channel-key=${values[2]}`,
          "--apply",
        ]);
      }
      // announcement_only drops the user and role arguments entirely.
      const only = run("true");
      expect(only.status).toBe(0);
      expect(only.stderr).toBe("");
      expect(JSON.parse(only.stdout)).toEqual([
        "run",
        "smoke:internal-action",
        "--",
        "--announcement-only",
        `--channel-key=${values[2]}`,
        "--apply",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("production deployment preserves configured triggers", () => {
  it("uploads the exact target version and promotes it through the shared gradual action", () => {
    const workflow = read(".github/workflows/deploy-production.yml");
    const action = read(".github/actions/gradual-promote/action.yml");
    const upload = workflow.indexOf(
      'npx wrangler versions upload --env production --tag "${DEPLOY_SHA:?}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"',
    );
    const gradual = workflow.indexOf(
      "uses: TogetherWeOwn/.github/actions/gradual-promote@89c290be20c0044efaf6916f28341c76e75fff06",
    );

    expect(upload).toBeGreaterThan(-1);
    expect(gradual).toBeGreaterThan(upload);
    // Gradual steps name both versions so traffic totals exactly 100;
    // the 100% step promotes the uploaded tag alone. The helper resolves
    // from the action's own path, never caller-relative, so every repo runs
    // the same traffic math with no copy.
    expect(action).not.toContain("node ci/gradual-promote.mjs");
    for (const percentage of [5, 50]) {
      expect(action).toContain(
        '"${{ github.action_path }}/gradual-promote.mjs" --deploy-spec "$VERSION_TAG" ' +
          `${percentage} "$PREV_VERSION"`,
      );
    }
    expect(action).toContain(
      '"${{ github.action_path }}/gradual-promote.mjs" --deploy-spec "$VERSION_TAG" 100 "$PREV_VERSION"',
    );
    expect(action).toContain("npx wrangler versions deploy --env production");
    expect(workflow).not.toContain("wrangler triggers deploy");
    expect(workflow).not.toContain("wrangler deploy --env production");
    expect(action).not.toContain("wrangler triggers deploy");
    expect(action).not.toContain("wrangler deploy --env production");
  });

  it("never attaches production jobs from the automatic promotion lane", () => {
    const workflow = read(".github/workflows/deploy-production.yml");
    // The production consumers/crons move exactly once, by the authorized
    // Operator transfer in docs/production-jobs-handoff.md (pause, detach
    // the web Worker, attach two-web-jobs-production, resume). An automatic
    // jobs deploy before that transfer completes would attach a second
    // consumer beside the still-live web one, so the promotion lane must not
    // reference the jobs config until the transfer's follow-up wires the
    // steady-state jobs deploy deliberately.
    expect(workflow).not.toContain("wrangler.jobs.jsonc");
    expect(workflow).not.toContain("two-web-jobs-production");
    // The drift probe stays unwired from the promotion lane until the
    // post-transfer follow-up wires it deliberately: wiring it now would fail
    // every production promotion while triggers are still web-owned. That
    // follow-up removes this assertion when it adds the probe step.
    expect(workflow).not.toContain("check-production-triggers");
  });

  it("pins production crons and queue consumers to the reviewed config", () => {
    type Consumer = {
      queue?: unknown;
      max_retries?: unknown;
      max_batch_size?: unknown;
      max_batch_timeout?: unknown;
    };
    type Producer = { binding?: unknown; queue?: unknown };
    const config = readWranglerConfig(read("wrangler.jsonc")) as {
      triggers?: unknown;
      queues?: { consumers?: Consumer[]; producers?: Producer[] };
      env?: {
        production?: {
          triggers?: unknown;
          queues?: { consumers?: Consumer[]; producers?: Producer[] };
        };
      };
    };
    const jobsConfig = readWranglerConfig(read("wrangler.jobs.jsonc")) as {
      triggers?: unknown;
      queues?: { consumers?: Consumer[]; producers?: Producer[] };
      env?: {
        production?: {
          triggers?: unknown;
          queues?: { consumers?: Consumer[]; producers?: Producer[] };
        };
      };
    };
    // `versions upload`/`deploy` never reconcile triggers, and `wrangler
    // triggers deploy` is banned above (it also syncs routes/domains and
    // re-triggers 100117). The pins below are literal reviewed values, not
    // staging-relative: any schedule/consumer change — even one made in both
    // blocks at once — fails CI until this test is updated in the same
    // release PR, and the runbook's "Production trigger reconciliation"
    // applies it without touching the apex custom domain.
    //
    // Production handoff: the web production env only produces, so a queue
    // keeps exactly one consumer and a cron exactly one owner. Both
    // production schedules and both production consumers live on
    // two-web-jobs-production (wrangler.jobs.jsonc env.production);
    // test/jobs-worker-config.test.ts pins that split.
    expect(config.env?.production?.triggers).toEqual({ crons: [] });
    expect(config.env?.production?.queues?.consumers ?? []).toEqual([]);
    // Staging handoff: the web Worker owns no cron and consumes no queue.
    // Both schedules and both staging consumers live on two-web-jobs
    // (wrangler.jobs.jsonc top level).
    expect(config.triggers).toEqual({ crons: [] });
    expect(config.queues?.consumers ?? []).toEqual([]);
    expect(jobsConfig.triggers).toEqual({ crons: ["*/10 * * * *", "0 0 * * *"] });
    expect(jobsConfig.env?.production?.triggers).toEqual({
      crons: ["*/10 * * * *", "0 0 * * *"],
    });
    const stagingConsumers = jobsConfig.queues?.consumers ?? [];
    const prodConsumers = jobsConfig.env?.production?.queues?.consumers ?? [];
    expect(
      [...prodConsumers].sort((a, b) => String(a.queue).localeCompare(String(b.queue))),
    ).toEqual([
      {
        queue: "two-web-next-production-internal-action",
        max_retries: 10,
        max_batch_size: 10,
        max_batch_timeout: 5,
      },
      {
        queue: "two-web-next-production-sync-event",
        max_retries: 10,
        max_batch_size: 10,
        max_batch_timeout: 5,
      },
    ]);
    expect(prodConsumers).toHaveLength(stagingConsumers.length);
    for (const consumer of prodConsumers) {
      expect(
        stagingConsumers.some(
          (peer) =>
            peer.max_retries === consumer.max_retries &&
            peer.max_batch_size === consumer.max_batch_size &&
            peer.max_batch_timeout === consumer.max_batch_timeout,
        ),
      ).toBe(true);
    }
    // Producers keep the same bindings so the promoted code talks to the
    // production queues, never the staging ones.
    const prodProducers = config.env?.production?.queues?.producers ?? [];
    expect(prodProducers.map((p) => `${p.binding}=${p.queue}`).sort()).toEqual([
      "INTERNAL_ACTION_QUEUE=two-web-next-production-internal-action",
      "SYNC_EVENT_QUEUE=two-web-next-production-sync-event",
    ]);
  });
});

describe("deployed revision marker is bound per environment", () => {
  const config = readWranglerConfig(read("wrangler.jsonc"));
  const stagingKit = readWranglerConfig(read("web/wrangler.staging.jsonc"));

  it("binds version_metadata on staging Kit, env.production and the jobs Worker", () => {
    expect(stagingKit.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    // Bindings are not inherited, so production declares its own copy: its
    // /up revision marker and release-tagged log lines depend on it.
    expect(config.env?.production?.version_metadata).toEqual({
      binding: "CF_VERSION_METADATA",
    });
    const jobs = readWranglerConfig(read("wrangler.jobs.jsonc"));
    expect(jobs.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });

  it("logs the live revision before any mutation and verifies the deployed commit after", () => {
    const record = deploy.indexOf(
      "run: node bin/revision-check.mjs https://next.togetherweown.com\n",
    );
    const verify = deploy.indexOf(
      'run: node bin/revision-check.mjs https://next.togetherweown.com "$DEPLOY_SHA"\n',
    );
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(deploy.indexOf("npx wrangler queues create"));
    expect(verify).toBeGreaterThan(
      deploy.indexOf("run: npx wrangler deploy --config web/wrangler.staging.jsonc"),
    );
    expect(verify).toBeLessThan(deploy.indexOf("node bin/smoke.mjs"));
    // /version is checked only after /up proved the new Version serves.
    const version = deploy.indexOf(
      'run: node bin/version-check.mjs https://next.togetherweown.com "$DEPLOY_SHA"\n',
    );
    expect(version).toBeGreaterThan(verify);
    expect(version).toBeLessThan(deploy.indexOf("node bin/smoke.mjs"));
    // A deploy of a commit that predates the checker (and /version) skips the
    // step instead of failing on a missing module.
    expect(deploy).toContain(
      "      - name: Verify /version reports the deployed commit\n" +
        "        if: hashFiles('bin/version-check.mjs') != ''\n",
    );
    // The tag and the verified commit come from the same CI-verified expression.
    // Both staging deploys (web and jobs Workers) share that one tag, so the
    // expression appears four times: web deploy, jobs deploy, and the /up and
    // /version verify steps.
    const expr =
      "DEPLOY_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}";
    expect(deploy.split(expr)).toHaveLength(5);
  });
});

describe("native automatic production promotion", () => {
  const production = read(".github/workflows/deploy-production.yml");

  it("triggers on e2e-staging completion and a daily schedule backstop, keeping dispatch", () => {
    // Manual dispatch stays for explicit redeploys and recovery.
    expect(production).toContain("workflow_dispatch:");
    // Automatic promotion: post-staging completion plus a daily backstop.
    expect(production).toContain("workflows: [e2e-staging]");
    expect(production).toContain("types: [completed]");
    expect(production).toContain('cron: "17 14 * * *"');
    // Never on push or PR.
    expect(production).not.toContain("push:");
    expect(production).not.toContain("pull_request:");
  });

  it("only auto-starts preflight on successful main staging runs", () => {
    const preflight = production.slice(
      production.indexOf("\n  preflight:\n"),
      production.indexOf("\n  deploy-production:\n"),
    );
    expect(preflight).toContain("github.event_name == 'workflow_dispatch'");
    expect(preflight).toContain("github.event_name == 'schedule'");
    expect(preflight).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(preflight).toContain("github.event.workflow_run.head_branch == 'main'");
    // Same-repo guard: a fork's staging green must never promote this repo.
    expect(preflight).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("exits cleanly with no deploy when there is nothing soaked and green to promote", () => {
    // The resolver exits 0 with an empty sha on automatic triggers (never on
    // manual dispatch), and every later preflight step stands down on empty.
    const resolver = read("ci/resolve-promotion-sha.mjs");
    expect(resolver).toContain('GITHUB_EVENT_NAME !== "workflow_dispatch"');
    expect(resolver).toContain('appendFileSync(process.env.GITHUB_OUTPUT, "sha=\\n")');
    expect(production).toContain("id: target");
    expect(production).toContain("if: steps.target.outputs.sha != ''");
    // The deploy job stands down on empty sha or an already-live target.
    expect(production).toContain(
      "if: needs.preflight.outputs.sha != '' && needs.preflight.outputs.already_live != 'true'",
    );
  });

  it("skips the deploy when production already serves the target", () => {
    expect(production).toContain("id: live");
    expect(production).toContain("run: node ci/production-deploy-gate.mjs --already-live");
    expect(production).toContain("DEPLOY_SHA: ${{ steps.target.outputs.sha }}");
    expect(production).toContain("already_live: ${{ steps.live.outputs.already_live }}");
    expect(production).toContain("live_sha: ${{ steps.live.outputs.live_sha }}");
    // The live check derives the commit from the Cloudflare active version
    // (/up revision marker), like the production promoter.
    const gate = read("ci/production-deploy-gate.mjs");
    expect(gate).toContain('new URL("/up", origin)');
    expect(gate).toContain("revision?.commit");
  });

  it("soaks greens 30 minutes and blocks on any newer red staging run", () => {
    const resolver = read("ci/resolve-promotion-sha.mjs");
    expect(resolver).toContain("PROMOTION_SOAK_MS = 30 * 60 * 1000");
    expect(resolver).toContain("seenNewerRed");
    expect(resolver).toContain("nowMs - completedAt < PROMOTION_SOAK_MS");
  });

  it("refuses pending production migrations with a migrator-blocked error", () => {
    expect(production).toContain("run: node ci/production-deploy-gate.mjs --check-migrations");
    expect(production).toContain("LIVE_SHA: ${{ steps.live.outputs.live_sha }}");
    // Until the least-privilege migrator lands this stops instead of calling
    // db-migrate.yml; the comment records the future workflow_call.
    expect(production).toContain("db-migrate.yml");
    expect(production).toContain("workflow_call");
    expect(production).toContain("least-privilege migrator");
    // The check runs from the tip checkout, before the target re-checkout:
    // an older target's script could lack the flag and fall through to the
    // full gate without its enable vars, blocking rescue redeploys.
    const checkAt = production.indexOf(
      "run: node ci/production-deploy-gate.mjs --check-migrations",
    );
    const targetCheckoutAt = production.indexOf("ref: ${{ steps.target.outputs.sha }}");
    expect(checkAt).toBeGreaterThan(-1);
    expect(targetCheckoutAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(targetCheckoutAt);
    // Audited manual continuation: after db-migrate applied the entries out
    // of band, a dispatch input releases the stop on manual runs only.
    expect(production).toContain("migrations_applied:");
    expect(production).toContain("MIGRATIONS_APPLIED: ${{ inputs.migrations_applied }}");
  });

  it("passes the hold variable to both production gate steps", () => {
    const gates = production.split("run: node ci/production-deploy-gate.mjs\n").slice(1);
    expect(gates.length).toBe(2);
    for (const gate of gates) {
      const block = gate.split("\n      - ")[0];
      expect(block).toContain("PRODUCTION_HOLD_UNTIL: ${{ vars.PRODUCTION_HOLD_UNTIL }}");
    }
    const gate = read("ci/production-deploy-gate.mjs");
    expect(gate).toContain("PRODUCTION_HOLD_MAX_MS = 24 * 60 * 60 * 1000");
    expect(gate).toContain("assertProductionHold(env)");
  });
});
