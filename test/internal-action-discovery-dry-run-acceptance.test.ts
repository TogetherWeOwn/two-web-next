import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// OWNERSHIP: independent acceptance handoff; builder changes production code,
// not this file. Corrections return to the test author. Fixtures only, no DB,
// inherited credentials, live services or actual bot effects.
// Breaks caught: help after validation/effects, dry-run reaching apply, ambiguous
// modes admitted, raw argv echo, lost JSON identities/remediation, changed apply
// payloads, production-host admission, and redirect-following signed requests.

const RUN_ID = "discovery-repeat-1";
const MARKER = "fixture-argv-must-not-echo";
const FIXTURE_ENV = {
  BOT_ENDPOINT_URL: "https://bot-fixture.invalid",
  BOT_PRODUCTION_URL: "https://production-fixture.invalid",
  APP_URL: "https://web-fixture.invalid",
};
const CREDENTIALS = {
  BOT_SHARED_SECRET: "fixture-only-secret-value",
  BOT_KEY_ID: "fixture-key",
};
const INPUTS = [
  "--discord-id=900000000000009999",
  "--role-key=rocketleague",
  "--channel-key=qa-throwaway",
] as const;
const TOOLS = [
  {
    name: "smoke",
    ids: [
      "role-assign-ok",
      "announcement-post-ok",
      "retry-ok",
      "retry-replay-flag",
      "retry-message-id",
      "event-upsert-ok",
    ],
    plan: "planBotSmoke",
    run: "runBotSmoke",
    failed: "SMOKE_CHECKS_FAILED",
  },
  {
    name: "drill",
    ids: [
      "role-assign-null-carrier",
      "announcement-uuid-carrier",
      "role-assign-handled",
      "announcement-post-handled",
    ],
    plan: "planInternalActionDrill",
    run: "runInternalActionDrill",
    failed: "DRILL_CHECKS_FAILED",
  },
] as const;
type Tool = (typeof TOOLS)[number];
type Request = { url: string; method: string; redirect: string; body: string; key: string | null };
type Evidence = { calls: Record<string, number>; env: string[]; requests: Request[] };

// A child-only import hook wraps real exports without replacing their behavior.
// It observes target/plan/client/producer boundaries, including calls made by
// the drill's real handler. The only fake is the external fetch boundary; its
// requests are captured on fd 3, never sent. Socket denial also fences direct
// HTTP/DB escapes. Positive apply controls prove both observers are live.
const PRELOAD = `
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
const evidence = { calls: {}, env: [], requests: [] };
globalThis.__discoveryEvidence = evidence;
const bump = name => { evidence.calls[name] = (evidence.calls[name] ?? 0) + 1; };
process.on('exit', () => writeSync(3, JSON.stringify(evidence)));
const mode = process.env.DISCOVERY_RESPONSE;
const watched = new Set(['BOT_ENDPOINT_URL','BOT_PRODUCTION_URL','APP_URL','BOT_SHARED_SECRET','BOT_KEY_ID']);
process.env = new Proxy(process.env, { get(target, key) {
  if (watched.has(key)) evidence.env.push(key);
  return Reflect.get(target, key);
} });
Socket.prototype.connect = function () { bump('socket'); throw new Error('offline fixture denies sockets'); };
syncBuiltinESMExports();
const seen = new Set();
globalThis.fetch = async (url, init) => {
  bump('fetch');
  const headers = new Headers(init.headers);
  const key = headers.get('Idempotency-Key');
  evidence.requests.push({ url: String(url), method: init.method, redirect: init.redirect, body: init.body, key });
  if (mode === 'failure') throw new Error('fixture-provider-raw-text');
  if (mode === 'redirect') return new Response(null, { status: 307, headers: { Location: 'https://production-fixture.invalid' } });
  const action = JSON.parse(init.body).action;
  const replayed = key !== null && seen.has(key);
  if (key !== null) seen.add(key);
  const result = action === 'role.assign' ? { outcome: 'assigned' }
    : action === 'announcement.post' ? { message_id: 'fixture-message' }
    : { outcome: 'created', event_id: 'fixture-event' };
  return Response.json({ ok: true, request_id: 'fixture-request', result }, {
    headers: replayed ? { 'Idempotent-Replay': 'true' } : {}
  });
};
const modules = new Map([
  ['src/probes/bot-smoke.ts', ['stagingEndpoint','planBotSmoke','runBotSmoke']],
  ['src/probes/internal-action-drill.ts', ['resolveDrillTarget','planInternalActionDrill','runInternalActionDrill']],
  ['src/bot/client.ts', ['createBotClient']],
  ['src/jobs/call-internal-action.ts', ['dispatchRoleAssign','dispatchAnnouncement','handleCallInternalAction']],
].map(([path, names]) => [pathToFileURL(process.cwd() + '/' + path).href, names]));
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  const names = modules.get(resolved.url);
  if (!names) return resolved;
  const actual = JSON.stringify(resolved.url + '?discovery-original');
  const source = 'import * as real from ' + actual + '; export * from ' + actual + ';' +
    names.map(name => 'export function ' + name + '(...args) { const c = globalThis.__discoveryEvidence.calls; c[' +
      JSON.stringify(name) + '] = (c[' + JSON.stringify(name) + '] ?? 0) + 1; return real.' + name + '(...args); }').join('');
  return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
} });
`;

function cli(
  tool: Tool,
  args: readonly string[],
  env: Record<string, string> = FIXTURE_ENV,
  response = "success",
) {
  const child = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "./bin/ts-hook.mjs",
      "--import",
      `data:text/javascript,${encodeURIComponent(PRELOAD)}`,
      `bin/internal-action-${tool.name}.mjs`,
      ...args,
    ],
    {
      env: { PATH: process.env.PATH, ...env, DISCOVERY_RESPONSE: response },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  const observation = child.output[3];
  expect(observation, child.stderr).toBeTruthy();
  const evidence = JSON.parse(String(observation)) as Evidence;
  expect(evidence.calls.socket ?? 0).toBe(0);
  return { code: child.status, stdout: child.stdout, stderr: child.stderr, evidence };
}

function noEffects(evidence: Evidence) {
  for (const name of [
    "createBotClient",
    "runBotSmoke",
    "runInternalActionDrill",
    "dispatchRoleAssign",
    "dispatchAnnouncement",
    "handleCallInternalAction",
    "fetch",
  ]) {
    expect(evidence.calls[name] ?? 0, name).toBe(0);
  }
  expect(evidence.requests).toEqual([]);
}

function jsonOutput(result: ReturnType<typeof cli>) {
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const doc = JSON.parse(result.stdout);
  const keys =
    doc.mode === "plan"
      ? [
          "version",
          "tool",
          "mode",
          "runId",
          "target",
          "checks",
          "next",
          ...(doc.tool === "internal-action-smoke"
            ? ["scope", ...(doc.scope === "full" ? ["eventKey"] : [])]
            : ["webOrigin"]),
        ]
      : doc.mode === "report"
        ? [
            "version",
            "tool",
            "mode",
            "runId",
            "ok",
            "checks",
            "failures",
            "next",
            ...(doc.ok ? [] : ["errorCode"]),
          ]
        : ["version", "tool", "mode", "checks", "errorCode", "message", "next"];
  expect(Object.keys(doc).sort()).toEqual(keys.sort());
  expect(doc.version).toBe(1);
  expect(doc.checks).toBeInstanceOf(Array);
  expect(doc.next.length).toBeGreaterThan(0);
  expect(result.stdout + result.stderr).not.toContain(CREDENTIALS.BOT_SHARED_SECRET);
  expect(result.stdout + result.stderr).not.toContain("fixture-provider-raw-text");
  return doc;
}

function planOutput(result: ReturnType<typeof cli>, tool: Tool) {
  noEffects(result.evidence);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.evidence.calls[tool.plan]).toBe(1);
  expect(result.evidence.env).not.toContain("BOT_SHARED_SECRET");
  expect(result.evidence.env).not.toContain("BOT_KEY_ID");
  const doc = jsonOutput(result);
  expect(doc).toMatchObject({
    tool: `internal-action-${tool.name}`,
    mode: "plan",
    runId: RUN_ID,
    target: FIXTURE_ENV.BOT_ENDPOINT_URL,
    next: ["Re-run with --apply to execute this plan against the staging target."],
  });
  expect(doc.checks.map((check: { id: string }) => check.id)).toEqual(tool.ids);
  expect(doc.checks.every((check: object) => Object.keys(check).sort().join() === "id,label")).toBe(
    true,
  );
  expect(doc).not.toHaveProperty("ok");
  expect(doc).not.toHaveProperty("failures");
  expect(doc).not.toHaveProperty("errorCode");
  return doc;
}

for (const tool of TOOLS) {
  describe(`${tool.name}: discovery precedes all validation and work`, () => {
    it.each([
      ["bare", ["--help"]],
      ["first", ["--help", ...INPUTS]],
      ["middle", [INPUTS[0], "--help", ...INPUTS.slice(1)]],
      ["last", [...INPUTS, "--help"]],
      ["missing value", ["--discord-id", "--help"]],
      ["invalid input", ["--run-id=bad/id", "--help", "--discord-id=bad"]],
      ["unknown with json", [`--unknown=${MARKER}`, "--json", "--help"]],
      ["conflicting modes", ["--apply", "--help", "--dry-run", "--json"]],
      ["duplicate modes", ["--apply", "--apply", "--help"]],
      ["valued modes", ["--apply=true", "--help", "--dry-run=false"]],
      ["scope contradiction", ["--announcement-only", "--role-key=x", "--help"]],
    ])("help wins over %s with no target, plan, credential or effect calls", (_name, argv) => {
      const result = cli(tool, argv, {});
      noEffects(result.evidence);
      expect(result.evidence.calls).toEqual({});
      expect(result.evidence.env).toEqual([]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^Usage:/i);
      expect(result.stdout).toContain("--dry-run");
      expect(result.stdout).toContain("--apply");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("docs/bot-probe-staging.md");
      expect(result.stdout).not.toContain(MARKER);
    });

    it("help is static even with poisoned target/secret configuration", () => {
      const clean = cli(tool, ["--help"], {});
      const poisoned = cli(tool, ["--json", `--unknown=${MARKER}`, "--help"], {
        BOT_ENDPOINT_URL: MARKER,
        BOT_PRODUCTION_URL: MARKER,
        APP_URL: "https://togetherweown.com",
        ...CREDENTIALS,
      });
      const configured = cli(tool, [...INPUTS, "--apply", "--help"], {
        ...FIXTURE_ENV,
        ...CREDENTIALS,
      });
      expect(configured.evidence).toEqual({ calls: {}, env: [], requests: [] });
      expect(configured.code).toBe(0);
      expect(configured.stdout).toBe(clean.stdout);
      expect(configured.stderr).toBe("");
      expect(clean.code).toBe(0);
      expect(poisoned.code).toBe(0);
      expect(poisoned.stdout).toBe(clean.stdout);
      expect(poisoned.stderr).toBe("");
      expect(poisoned.evidence).toEqual({ calls: {}, env: [], requests: [] });
    });
  });

  describe(`${tool.name}: explicit safe mode`, () => {
    it("preservation control: implicit preview remains a versioned, effect-free plan", () => {
      const doc = planOutput(cli(tool, [...INPUTS, `--run-id=${RUN_ID}`, "--json"]), tool);
      if (tool.name === "smoke") {
        expect(doc.scope).toBe("full");
        expect(doc.eventKey).toBe("tog10112-aabd3be2a13a");
      } else {
        expect(doc.webOrigin).toBe(FIXTURE_ENV.APP_URL);
      }
    });

    it("bare dry-run also works without a caller-supplied run identity", () => {
      const result = cli(tool, [...INPUTS, "--dry-run", "--json"]);
      noEffects(result.evidence);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(jsonOutput(result)).toMatchObject({ mode: "plan", runId: null });
      // No byte comparison: unnamed smoke plans deliberately mint a fresh key.
    });

    it("preservation control: invalid run identity retains coded remediation and no effects", () => {
      const result = cli(tool, [...INPUTS, `--run-id=${MARKER}/bad`, "--json"]);
      noEffects(result.evidence);
      expect(result.code).toBe(2);
      expect(result.evidence.calls).toEqual({});
      expect(jsonOutput(result)).toMatchObject({
        mode: "error",
        errorCode: "INVALID_RUN_ID",
        checks: [],
        next: [
          "Choose a run identity of 1-64 letters, digits, underscore or hyphen (leading alnum) and re-run to preview.",
        ],
      });
      expect(result.stdout + result.stderr).not.toContain(MARKER);
    });

    it.each(["text", "json"])(
      "dry-run is byte-equivalent to implicit preview (%s, fixed identity)",
      (format) => {
        const args = [...INPUTS, `--run-id=${RUN_ID}`, ...(format === "json" ? ["--json"] : [])];
        const implicit = cli(tool, args);
        const explicit = cli(tool, [...args, "--dry-run"], { ...FIXTURE_ENV, ...CREDENTIALS });
        noEffects(explicit.evidence);
        expect(implicit.code).toBe(0);
        expect(explicit.code).toBe(0);
        expect(explicit.stderr).toBe("");
        expect(explicit.stdout).toBe(implicit.stdout);
        if (format === "json") planOutput(explicit, tool);
      },
    );

    it.each([
      ["conflict", ["--dry-run", "--apply"]],
      ["reversed conflict", ["--apply", "--dry-run"]],
      ["duplicate preview", ["--dry-run", "--dry-run"]],
      ["duplicate apply", ["--apply", "--apply"]],
      ["valued preview", [`--dry-run=${MARKER}`]],
      ["valued apply", [`--apply=${MARKER}`]],
      ["valued help", [`--help=${MARKER}`]],
      ["unknown", [`--unknown=${MARKER}`, "--apply"]],
    ])("refuses %s before target resolution or effects, without raw argv", (_name, extra) => {
      for (const json of [false, true]) {
        const result = cli(tool, [...INPUTS, ...extra, ...(json ? ["--json"] : [])], {});
        noEffects(result.evidence);
        expect(result.evidence.calls).toEqual({});
        expect(result.evidence.env).toEqual([]);
        expect(result.code).toBe(2);
        expect(result.stdout + result.stderr).toMatch(/Usage:/i);
        expect(result.stdout + result.stderr).not.toContain(MARKER);
        if (json) {
          expect(result.stderr).toBe("");
          expect(jsonOutput(result)).toMatchObject({
            mode: "error",
            errorCode: "INVALID_ARGUMENTS",
            checks: [],
          });
        } else {
          expect(result.stdout).toBe("");
        }
      }
    });

    it.each(["implicit", "dry-run", "apply"])(
      "production bot hostname stays refused (%s)",
      (mode) => {
        const result = cli(
          tool,
          [...INPUTS, "--json", ...(mode === "implicit" ? [] : [`--${mode}`])],
          {
            ...FIXTURE_ENV,
            BOT_ENDPOINT_URL: "https://PRODUCTION-fixture.invalid.:9443",
          },
        );
        noEffects(result.evidence);
        expect(result.code).toBe(2);
        expect(jsonOutput(result)).toMatchObject({
          mode: "error",
          errorCode: "INVALID_TARGET",
          checks: [],
        });
        expect(result.evidence.calls[tool.plan] ?? 0).toBe(0);
      },
    );

    it("preservation control: missing credentials retain coded remediation before fetch", () => {
      const result = cli(tool, [...INPUTS, "--apply", "--json"]);
      expect(result.code).toBe(2);
      expect(result.evidence.requests).toEqual([]);
      expect(result.evidence.calls[tool.run] ?? 0).toBe(0);
      expect(jsonOutput(result)).toMatchObject({
        mode: "error",
        errorCode: "MISSING_CONFIGURATION",
        checks: [],
        next: ["Export BOT_SHARED_SECRET and BOT_KEY_ID, then re-run with --apply."],
      });
    });

    it("preservation control: failed apply retains exit 1, stable IDs and remediation", () => {
      const result = cli(
        tool,
        [...INPUTS, `--run-id=${RUN_ID}`, "--apply", "--json"],
        { ...FIXTURE_ENV, ...CREDENTIALS },
        "failure",
      );
      expect(result.code).toBe(1);
      expect(result.evidence.calls.fetch).toBeGreaterThan(0);
      const doc = jsonOutput(result);
      expect(doc).toMatchObject({
        mode: "report",
        runId: RUN_ID,
        ok: false,
        errorCode: tool.failed,
        next: [
          "Fix the failing checks, then re-run the same --run-id with --apply to resume the run.",
        ],
      });
      expect(doc.checks.map((check: { id: string }) => check.id)).toEqual(tool.ids);
      expect(doc.failures.length).toBeGreaterThan(0);
    });

    it("preservation control: real apply replays payloads and carriers through the signed transport", () => {
      const args = [...INPUTS, `--run-id=${RUN_ID}`, "--apply", "--json"];
      const first = cli(tool, args, { ...FIXTURE_ENV, ...CREDENTIALS });
      const second = cli(tool, args, { ...FIXTURE_ENV, ...CREDENTIALS });
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const doc = jsonOutput(first);
      expect(doc).toMatchObject({ mode: "report", ok: true, failures: [], runId: RUN_ID });
      expect(doc).not.toHaveProperty("errorCode");
      expect(doc.checks.map((check: { id: string }) => check.id)).toEqual(tool.ids);
      expect(first.evidence.calls[tool.run]).toBe(1);
      const requests = first.evidence.requests;
      expect(second.evidence.requests).toEqual(requests);
      expect(requests.map((request) => JSON.parse(request.body).action)).toEqual(
        tool.name === "smoke"
          ? ["role.assign", "announcement.post", "announcement.post", "event.upsert"]
          : ["role.assign", "announcement.post"],
      );
      expect(JSON.parse(requests[0]!.body)).toEqual({
        action: "role.assign",
        discord_id: "900000000000009999",
        role_key: "rocketleague",
      });
      expect(requests[0]!.key).toBeNull();
      expect(requests[1]!.key).toBe(
        tool.name === "smoke"
          ? "53bc5302-cd85-439c-884a-fa146fb83e69"
          : "ccd2d2c2-3a4b-4c24-a8f3-932286f97971",
      );
      const announcement = JSON.parse(requests[1]!.body);
      expect(Object.keys(announcement).sort()).toEqual(["action", "body", "channel_key"]);
      expect(announcement.channel_key).toBe("qa-throwaway");
      expect(announcement.body.endsWith(`${tool.name} run. Ignore. 2030-08-05T15:56:52.663Z`)).toBe(
        true,
      );
      for (const request of requests) {
        expect(request.url).toBe("https://bot-fixture.invalid/internal/actions");
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("manual");
      }
      if (tool.name === "smoke") {
        expect(requests[2]).toEqual(requests[1]);
        const event = JSON.parse(requests[3]!.body);
        expect(event).toMatchObject({
          action: "event.upsert",
          event_key: "tog10112-aabd3be2a13a",
          starts_at: "2030-08-06T15:56:52.663Z",
          ends_at: "2030-08-06T16:56:52.663Z",
          location: "Smoke run - ignore",
          description: "Created by the two-web-next internal-action staging smoke",
        });
        expect(Object.keys(event).sort()).toEqual([
          "action",
          "description",
          "ends_at",
          "event_key",
          "location",
          "name",
          "starts_at",
        ]);
        expect(event.name.endsWith("smoke event")).toBe(true);
        expect(requests[3]!.key).toBe("dec4dc6e-a48e-402b-a3b1-30367deba34b");
      } else {
        expect(first.evidence.calls.dispatchRoleAssign).toBe(1);
        expect(first.evidence.calls.dispatchAnnouncement).toBe(1);
        expect(first.evidence.calls.handleCallInternalAction).toBe(2);
      }
    });

    it("preservation control: redirect is refused without a redirected request", () => {
      const result = cli(
        tool,
        [...INPUTS, "--apply", "--json"],
        { ...FIXTURE_ENV, ...CREDENTIALS },
        "redirect",
      );
      expect(result.code).toBe(1);
      expect(jsonOutput(result).errorCode).toBe(tool.failed);
      expect(result.evidence.requests.length).toBeGreaterThan(0);
      for (const request of result.evidence.requests) {
        expect(request.url).toBe("https://bot-fixture.invalid/internal/actions");
        expect(request.redirect).toBe("manual");
      }
    });
  });
}

it("smoke announcement-only also accepts explicit dry-run without skipped inputs", () => {
  const args = [
    "--announcement-only",
    "--channel-key=qa-throwaway",
    `--run-id=${RUN_ID}`,
    "--json",
  ];
  const implicit = cli(TOOLS[0], args);
  const explicit = cli(TOOLS[0], [...args, "--dry-run"]);
  noEffects(explicit.evidence);
  expect(implicit.code).toBe(0);
  expect(explicit.code).toBe(0);
  expect(explicit.stdout).toBe(implicit.stdout);
  expect(jsonOutput(explicit)).toMatchObject({ mode: "plan", scope: "announcement-only" });
  expect(jsonOutput(explicit).checks.map((check: { id: string }) => check.id)).toEqual(
    TOOLS[0].ids.slice(1, 5),
  );
});

it.each(["--dry-run", "--apply"])(
  "drill refuses the production web apex before %s can run",
  (mode) => {
    const result = cli(TOOLS[1], [...INPUTS, mode, "--json"], {
      ...FIXTURE_ENV,
      APP_URL: "https://TOGETHERWEOWN.com.:9443",
    });
    noEffects(result.evidence);
    expect(result.code).toBe(2);
    expect(jsonOutput(result).errorCode).toBe("INVALID_TARGET");
    expect(result.evidence.calls.planInternalActionDrill ?? 0).toBe(0);
  },
);

it("help links one bounded repo procedure with mode, remediation and offline-check vocabulary", () => {
  const result = cli(TOOLS[0], ["--help"], {});
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("docs/bot-probe-staging.md");
  const procedure = readFileSync("docs/bot-probe-staging.md", "utf8");
  expect(procedure.length).toBeLessThan(8000);
  for (const token of [
    "--help",
    "--dry-run",
    "--apply",
    "--json",
    "--run-id",
    "INVALID_ARGUMENTS",
    "INVALID_TARGET",
    "MISSING_CONFIGURATION",
  ]) {
    expect(procedure, token).toContain(token);
  }
  expect(procedure).toContain(
    "npx vitest run test/internal-action-discovery-dry-run-acceptance.test.ts",
  );
  expect(procedure).toMatch(/exit\s+0/i);
  expect(procedure).toMatch(/exit\s+1/i);
  expect(procedure).toMatch(/exit\s+2/i);
});
