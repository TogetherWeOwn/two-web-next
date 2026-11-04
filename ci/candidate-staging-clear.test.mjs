import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertNormalStagingClear } from "./candidate-staging-clear.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const TOKEN = "fixture-only";
const REFUSED = /^Error: Staging occupancy guard refused$/;

function context() {
  return {
    actions: "true",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    repository: "TogetherWeOwn/two-web-next",
    runAttempt: "1",
    runId: "123",
    sha: "a".repeat(40),
    workflowRef: "TogetherWeOwn/two-web-next/.github/workflows/staging-smoke.yml@refs/heads/main",
  };
}

function deployment() {
  return {
    id: 1,
    creator: { id: 41898282 },
    performed_via_github_app: { id: 15368 },
    environment: "candidate-staging-occupancy",
    task: "candidate-staging-occupancy-v1",
    ref: "b".repeat(40),
    sha: "b".repeat(40),
    production_environment: false,
    transient_environment: false,
    payload: {
      schema: "two.candidate-occupancy.v1",
      q: "c".repeat(64),
      controllerSha: "b".repeat(40),
      headSha: "d".repeat(40),
      runId: "456",
      runAttempt: "1",
      createdAt: "2026-11-04T18:00:00.000Z",
      baseline: {
        artifactId: "789",
        archiveSha256: "e".repeat(64),
        stateSha256: "f".repeat(64),
        expiresAt: "2026-11-20T18:00:00.000Z",
      },
    },
  };
}

function fixture({ rows = [], statuses = [], response } = {}) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(url.startsWith(`${BASE}/deployments`));
    if (response) return response(url, init);
    if (url === `${BASE}/deployments?environment=candidate-staging-occupancy&per_page=100&page=1`) {
      return Response.json(rows);
    }
    assert.equal(url, `${BASE}/deployments/1/statuses?per_page=100&page=1`);
    return Response.json(statuses);
  }
  return { calls, fetchImpl };
}

for (const event of ["push", "schedule", "workflow_run", "workflow_dispatch"]) {
  test(`main-only ${event} guard reads the journal without a write`, async () => {
    const server = fixture();
    assert.equal(
      await assertNormalStagingClear({ token: TOKEN, context: { ...context(), event }, ...server }),
      undefined,
    );
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].init.method, "GET");
  });
}

for (const [field, values] of Object.entries({
  actions: [undefined, false, "false"],
  event: ["pull_request", "pull_request_target", "repository_dispatch", "", undefined],
  ref: ["refs/heads/candidate", "refs/pull/42/merge", "refs/tags/main", undefined],
  repository: ["attacker/two-web-next", "TogetherWeOwn/two-web-next/extra", undefined],
  runId: ["0", "01", "1;id", 123, undefined],
  runAttempt: ["0", "01", "1\n", 1, undefined],
  sha: ["A".repeat(40), "a".repeat(39), "main", undefined],
  workflowRef: [
    "TogetherWeOwn/two-web-next/.github/workflows/staging-smoke.yml@refs/heads/candidate",
    "TogetherWeOwn/two-web-next/.github/workflows/../staging-smoke.yml@refs/heads/main",
    "attacker/two-web-next/.github/workflows/staging-smoke.yml@refs/heads/main",
    "TogetherWeOwn/two-web-next/.github/workflows/staging-smoke.yml@refs/heads/main\n",
    undefined,
  ],
})) {
  for (const [index, value] of values.entries()) {
    test(`invalid ${field} case ${index} refuses before credential use`, async () => {
      const server = fixture();
      await assert.rejects(
        assertNormalStagingClear({
          token: TOKEN,
          context: { ...context(), [field]: value },
          ...server,
        }),
        REFUSED,
      );
      assert.equal(server.calls.length, 0);
    });
  }
}

for (const value of [undefined, null, [], {}, { ...context(), account: "production" }]) {
  test(`invalid context shape ${JSON.stringify(value)} refuses without HTTP`, async () => {
    const server = fixture();
    await assert.rejects(
      assertNormalStagingClear({ token: TOKEN, context: value, ...server }),
      REFUSED,
    );
    assert.equal(server.calls.length, 0);
  });
}

test("missing options or token refuse without an alternate principal", async () => {
  await assert.rejects(assertNormalStagingClear(), REFUSED);
  const server = fixture();
  for (const token of [undefined, "", "a b", "x".repeat(4097)]) {
    await assert.rejects(
      assertNormalStagingClear({ token, context: context(), ...server }),
      REFUSED,
    );
  }
  assert.equal(server.calls.length, 0);
});

for (const state of [
  undefined,
  "failure",
  "error",
  "in_progress",
  "queued",
  "pending",
  "inactive",
]) {
  test(`unrestored occupancy (${state ?? "no status"}) refuses normal work`, async () => {
    const server = fixture({
      rows: [deployment()],
      statuses: state
        ? [
            {
              id: 2,
              creator: { id: 41898282 },
              performed_via_github_app: { id: 15368 },
              environment: "candidate-staging-occupancy",
              state,
            },
          ]
        : [],
    });
    await assert.rejects(
      assertNormalStagingClear({ token: TOKEN, context: context(), ...server }),
      REFUSED,
    );
    assert.equal(server.calls.length, 2);
  });
}

test("success requires the pinned bot/App and bounded restoration digest", async () => {
  const status = {
    id: 2,
    creator: { id: 41898282 },
    performed_via_github_app: { id: 15368 },
    environment: "candidate-staging-occupancy",
    state: "success",
    description: `two.restore.v1:${"a".repeat(64)}`,
  };
  const server = fixture({ rows: [deployment()], statuses: [status] });
  await assertNormalStagingClear({ token: TOKEN, context: context(), ...server });
  for (const mutate of [
    (row) => {
      row.creator.id = 7;
    },
    (row) => {
      row.performed_via_github_app.id = 8;
    },
    (row) => {
      row.description = "success";
    },
    (row) => {
      row.environment = "production";
    },
  ]) {
    const invalid = structuredClone(status);
    mutate(invalid);
    const denied = fixture({ rows: [deployment()], statuses: [invalid] });
    await assert.rejects(
      assertNormalStagingClear({ token: TOKEN, context: context(), ...denied }),
      REFUSED,
    );
  }
});

for (const mutate of [
  (row) => {
    row.creator.id = 7;
  },
  (row) => {
    row.performed_via_github_app.id = 8;
  },
  (row) => {
    delete row.payload;
  },
  (row) => {
    row.production_environment = true;
  },
  (row) => {
    row.payload.baseline.stateSha256 = "private-data";
  },
]) {
  test("foreign or malformed journal entries cannot authorize normal work", async () => {
    const row = deployment();
    mutate(row);
    const server = fixture({ rows: [row] });
    await assert.rejects(
      assertNormalStagingClear({ token: TOKEN, context: context(), ...server }),
      REFUSED,
    );
    assert.equal(server.calls.length, 1);
  });
}

for (const status of [401, 403, 429, 500, 302]) {
  test(`HTTP ${status} refuses once and redacts remote content`, async () => {
    const server = fixture({
      response: () => new Response(`private-data ${TOKEN}`, { status }),
    });
    await assert.rejects(
      assertNormalStagingClear({ token: TOKEN, context: context(), ...server }),
      REFUSED,
    );
    assert.equal(server.calls.length, 1);
  });
}

test("transport and malformed JSON errors remain fixed redacted refusals", async () => {
  for (const response of [
    () => {
      throw new Error(`private-data ${TOKEN}`);
    },
    () =>
      new Response(`private-data ${TOKEN}`, { headers: { "content-type": "application/json" } }),
    () => Response.json({ private: TOKEN }),
  ]) {
    const server = fixture({ response });
    await assert.rejects(
      assertNormalStagingClear({ token: TOKEN, context: context(), ...server }),
      REFUSED,
    );
    assert.equal(server.calls.length, 1);
  }
});

test("CLI rejects options, missing runtime and candidate refs without exposing secrets", () => {
  const script = fileURLToPath(new URL("./candidate-staging-clear.mjs", import.meta.url));
  for (const [args, env] of [
    [["--ignore-dirty"], {}],
    [[], {}],
    [[], { GITHUB_TOKEN: TOKEN, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/candidate" }],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Staging occupancy guard refused\n");
  }
});
