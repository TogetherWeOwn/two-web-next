import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateIdentity } from "./candidate-staging-admission.mjs";
import {
  createCandidateStagingJournal,
  recoverCandidateStaging,
} from "./candidate-staging-occupancy.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const NOW = Date.parse("2026-11-04T18:00:00.000Z");
const ENVIRONMENT = "candidate-staging-occupancy";
const author = { creator: { id: 7 }, performed_via_github_app: { id: 8 } };

function input() {
  return {
    schema: "two.candidate-occupancy.v1",
    q: "a".repeat(64),
    controllerSha: "b".repeat(40),
    headSha: "c".repeat(40),
    runId: "123",
    runAttempt: "2",
    createdAt: new Date(NOW).toISOString(),
    baseline: {
      artifactId: "456",
      archiveSha256: "d".repeat(64),
      stateSha256: "e".repeat(64),
      expiresAt: new Date(NOW + 15 * 86400000).toISOString(),
    },
  };
}

function deployment(id = 1, value = input()) {
  return {
    id,
    ...author,
    environment: ENVIRONMENT,
    task: "candidate-staging-occupancy-v1",
    ref: value.controllerSha,
    sha: value.controllerSha,
    production_environment: false,
    transient_environment: false,
    payload: value,
  };
}

function proof(row = deployment()) {
  return {
    schema: "two.candidate-restoration.v1",
    q: row.payload.q,
    deploymentId: String(row.id),
    baselineStateSha256: row.payload.baseline.stateSha256,
    providerStateSha256: row.payload.baseline.stateSha256,
    smokeSha256: "f".repeat(64),
    nextUploadSha256: "1".repeat(64),
    verifiedAt: new Date(NOW).toISOString(),
  };
}

function status(state = "success", id = 10) {
  return {
    id,
    ...author,
    state,
    environment: ENVIRONMENT,
    description: `two.restore.v1:${"2".repeat(64)}`,
  };
}

function fixture() {
  const state = { rows: [], statuses: new Map(), calls: [], intercept: null, sequence: 1000 };
  const fetchImpl = async (url, options) => {
    const request = { url, method: options.method, body: options.body && JSON.parse(options.body) };
    state.calls.push(request);
    assert.equal(options.headers.Authorization, "Bearer fixture-only");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.startsWith(BASE));
    if (state.intercept) {
      const response = await state.intercept(request, options);
      if (response !== undefined) return response;
    }
    const path = url.slice(BASE.length);
    let value;
    let code = 200;
    if (path.startsWith("/deployments?")) {
      assert.match(
        path,
        /^\/deployments\?environment=candidate-staging-occupancy&per_page=100&page=[1-6]$/,
      );
      const page = Number(new URL(url).searchParams.get("page"));
      value = state.rows.slice((page - 1) * 100, page * 100);
    } else if (/^\/deployments\/[1-9][0-9]*\/statuses\?per_page=100&page=[1-6]$/.test(path)) {
      const values = state.statuses.get(Number(path.split("/")[2])) ?? [];
      const page = Number(new URL(url).searchParams.get("page"));
      value = Array.isArray(values) ? values.slice((page - 1) * 100, page * 100) : values;
    } else if (/^\/deployments\/[1-9][0-9]*\/statuses$/.test(path)) {
      assert.equal(options.method, "POST");
      code = 201;
      value = { id: state.sequence++, ...author, ...request.body };
      const id = Number(path.split("/")[2]);
      state.statuses.set(id, [value, ...(state.statuses.get(id) ?? [])]);
    } else if (/^\/deployments\/[1-9][0-9]*$/.test(path)) {
      value = state.rows.find((row) => row.id === Number(path.split("/")[2]));
    } else {
      assert.equal(path, "/deployments");
      assert.equal(options.method, "POST");
      code = 201;
      value = deployment(state.sequence++, request.body.payload);
      state.rows.unshift(value);
    }
    return Response.json(value, { status: code });
  };
  const journal = createCandidateStagingJournal({
    token: "fixture-only",
    creatorId: "7",
    appId: "8",
    fetchImpl,
    now: () => NOW,
  });
  return { state, journal, fetchImpl };
}

async function refuses(operation, pattern = /^Candidate occupancy refused:/) {
  await assert.rejects(operation, (error) => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /fixture-only|injected|private-data/);
    return true;
  });
}

function boundFixture() {
  const f = fixture();
  const identity = candidateIdentity(
    { prNumber: "42", headSha: "c".repeat(40), ciRunId: "99", ciRunAttempt: "1" },
    {
      repositoryId: "1234",
      repository: "TogetherWeOwn/two-web-next",
      controllerSha: "b".repeat(40),
      launcherSha: "f".repeat(40),
      checkoutSha: "b".repeat(40),
      runId: "123",
      runAttempt: "2",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      path: ".github/workflows/candidate-staging.yml",
    },
  );
  const expectedPayload = { ...input(), q: identity.q };
  f.state.rows.push(deployment(1, structuredClone(expectedPayload)));
  const options = { deploymentId: "1", identity: structuredClone(identity), expectedPayload };
  return { ...f, options, guard: f.journal.bindRecovery(options), context: { q: identity.q } };
}

test("bound recovery re-reads the real journal and returns ownership only", async () => {
  const f = boundFixture();
  const first = await f.guard(f.context);
  assert.ok(Object.isFrozen(first));
  assert.equal(first.scope, "dirty-journal-ownership-only");
  assert.equal(first.promotable, false);
  assert.equal(first.q, f.context.q);
  assert.equal(first.deploymentId, "1");
  assert.match(first.payloadSha256, /^[a-f0-9]{64}$/);
  const count = f.state.calls.length;
  assert.ok(count > 0);
  assert.deepEqual(await f.guard(f.context), first);
  assert.equal(f.state.calls.length, count * 2);
  assert.ok(f.state.calls.every((call) => call.method === "GET"));
});

for (const [field, value] of [
  ["q", "0".repeat(64)],
  ["controllerSha", "0".repeat(40)],
  ["headSha", "0".repeat(40)],
  ["runId", "124"],
  ["runAttempt", "3"],
]) {
  test(`bound recovery refuses mismatched ${field} before requests`, () => {
    const f = boundFixture();
    f.options.expectedPayload[field] = value;
    assert.throws(() => f.journal.bindRecovery(f.options), {
      message: "Candidate occupancy refused: bound-ownership",
    });
    assert.equal(f.state.calls.length, 0);
  });
}

for (const [field, value] of [
  ["artifactId", "457"],
  ["archiveSha256", "0".repeat(64)],
  ["stateSha256", "0".repeat(64)],
  ["expiresAt", new Date(NOW + 16 * 86400000).toISOString()],
]) {
  test(`bound recovery refuses persisted baseline ${field} substitution`, async () => {
    const f = boundFixture();
    f.state.rows[0].payload.baseline[field] = value;
    await refuses(() => f.guard(f.context));
    assert.ok(f.state.calls.every((call) => call.method === "GET"));
  });
}

test("bound recovery refuses changed creation time even with the same Q and baseline", async () => {
  const f = boundFixture();
  f.state.rows[0].payload.createdAt = new Date(NOW - 1000).toISOString();
  await refuses(() => f.guard(f.context));
});

test("bound recovery snapshots the independently supplied identity and baseline pin", async () => {
  const f = boundFixture();
  f.options.identity.descriptor[4] = "0".repeat(40);
  f.options.expectedPayload.baseline.stateSha256 = "0".repeat(64);
  f.options.deploymentId = "2";
  assert.equal((await f.guard(f.context)).deploymentId, "1");
});

for (const context of [undefined, null, {}, { q: "0".repeat(64) }]) {
  test(`bound recovery refuses foreign context ${JSON.stringify(context)}`, async () => {
    const f = boundFixture();
    await refuses(() => f.guard(context));
    assert.equal(f.state.calls.length, 0);
  });
}

test("bound recovery refuses cancellation before and during journal reads", async () => {
  for (const during of [false, true]) {
    const f = boundFixture();
    const controller = new AbortController();
    if (during) f.state.intercept = () => controller.abort("private-data");
    else controller.abort("private-data");
    await refuses(() => f.guard(f.context, controller.signal));
    assert.equal(f.state.calls.length, during ? 1 : 0);
  }
});

test("bound recovery stops after clean publication and on a new dirty writer", async () => {
  const f = boundFixture();
  await f.guard(f.context);
  f.state.statuses.set(1, [status()]);
  await refuses(() => f.guard(f.context));
  f.state.rows.push(deployment(2, { ...input(), q: "0".repeat(64) }));
  await refuses(() => f.guard(f.context));
  assert.ok(f.state.calls.every((call) => call.method === "GET"));
});

test("bound recovery authenticates the journal writer, not only its payload", async () => {
  const f = boundFixture();
  f.state.rows[0].creator = { id: 9 };
  await refuses(() => f.guard(f.context));
});

test("dirty record is persisted and rediscovered before mutation; original baseline survives caller changes", async () => {
  const { journal, state } = fixture();
  const value = input();
  const row = await journal.begin(value);
  value.baseline.stateSha256 = "0".repeat(64);
  assert.equal(row.payload.baseline.stateSha256, "e".repeat(64));
  assert.equal(state.calls.filter((call) => call.method === "POST").length, 1);
  const body = state.calls.find((call) => call.method === "POST").body;
  assert.equal(body.production_environment, false);
  assert.equal(body.transient_environment, false);
  assert.equal(body.auto_merge, false);
  assert.deepEqual(body.required_contexts, []);
  assert.equal(body.ref, input().controllerSha);
  assert.deepEqual(
    (await journal.unresolved()).map((item) => item.id),
    [row.id],
  );
  await refuses(() => journal.assertClear());
  await refuses(() => journal.begin(input()));
  assert.equal(state.calls.filter((call) => call.method === "POST").length, 1);
});

test("verified exact-baseline recovery marks durable clean with non-promoting status", async () => {
  const { journal, state } = fixture();
  const row = await journal.begin(input());
  const sequence = [];
  const digest = await recoverCandidateStaging({
    journal,
    deploymentId: String(row.id),
    assertExclusive: async () => {
      sequence.push("lock");
    },
    restore: async (saved) => {
      assert.deepEqual(saved, row);
      sequence.push("restore");
    },
    verify: async (saved) => {
      sequence.push("verify");
      return proof(saved);
    },
  });
  assert.deepEqual(sequence, ["lock", "restore", "lock", "verify", "lock"]);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const write = state.calls.filter((call) => call.method === "POST").at(-1);
  assert.equal(write.body.auto_inactive, false);
  assert.equal(write.body.description, `two.restore.v1:${digest}`);
  assert.equal(write.body.environment, ENVIRONMENT);
  await journal.assertClear();
  assert.deepEqual(await journal.unresolved(), []);
});

for (const phase of ["lock-before", "restore", "lock-after", "verify", "lock-clean"]) {
  test(`recovery failure at ${phase} leaves dirty durable ownership and permits idempotent retry`, async () => {
    const { journal, state } = fixture();
    const row = await journal.begin(input());
    let locks = 0;
    await assert.rejects(
      recoverCandidateStaging({
        journal,
        deploymentId: String(row.id),
        assertExclusive: async () => {
          const position = ["lock-before", "lock-after", "lock-clean"][locks++];
          if (position === phase) throw new Error("local failure");
        },
        restore: async () => {
          if (phase === "restore") throw new Error("local failure");
        },
        verify: async () => {
          if (phase === "verify") throw new Error("local failure");
          return proof(row);
        },
      }),
    );
    await refuses(() => journal.assertClear());
    assert.equal(state.calls.filter((call) => call.method === "POST").length, 1);
    await recoverCandidateStaging({
      journal,
      deploymentId: String(row.id),
      assertExclusive: async () => {},
      restore: async () => {},
      verify: async () => proof(row),
    });
    await journal.assertClear();
  });
}

test("duplicate recovery after clean refuses before restoring an old baseline", async () => {
  const { journal } = fixture();
  const row = await journal.begin(input());
  await journal.markRestored(String(row.id), proof(row));
  let restored = false;
  await refuses(() =>
    recoverCandidateStaging({
      journal,
      deploymentId: String(row.id),
      assertExclusive: async () => {},
      restore: async () => {
        restored = true;
      },
      verify: async () => proof(row),
    }),
  );
  assert.equal(restored, false);
});

test("old clean session cannot restore over a subsequent dirty session", async () => {
  const { journal } = fixture();
  const first = await journal.begin(input());
  await journal.markRestored(String(first.id), proof(first));
  const secondInput = input();
  secondInput.q = "3".repeat(64);
  const second = await journal.begin(secondInput);
  let restored = false;
  await refuses(() =>
    recoverCandidateStaging({
      journal,
      deploymentId: String(first.id),
      assertExclusive: async () => {},
      restore: async () => {
        restored = true;
      },
      verify: async () => proof(first),
    }),
  );
  assert.equal(restored, false);
  assert.equal((await journal.requireDirty(String(second.id))).id, second.id);
});

for (const stateName of ["error", "failure", "inactive", "in_progress", "queued", "pending"]) {
  test(`${stateName} is never clean, even with an older success or an expired baseline`, async () => {
    const { journal, state } = fixture();
    const row = deployment();
    row.payload.baseline.expiresAt = "2026-10-01T00:00:00.000Z";
    state.rows.push(row);
    state.statuses.set(1, [status(stateName, 11), status("success", 10)]);
    await refuses(() => journal.assertClear());
  });
}

const badPayloads = [
  ["schema", "other"],
  ["q", "x".repeat(64)],
  ["controllerSha", "main"],
  ["headSha", "C".repeat(40)],
  ["runId", "01"],
  ["runAttempt", "0"],
  ["createdAt", "yesterday"],
  ["createdAt", "2026-11-04T17:00:00.000Z"],
  ["createdAt", "2026-11-04T19:00:00.000Z"],
  ["extra", "private-data"],
];
for (const [field, value] of badPayloads) {
  test(`refuses malformed or stale creation ${field}=${value}`, async () => {
    const { journal, state } = fixture();
    const changed = input();
    changed[field] = value;
    await refuses(() => journal.begin(changed));
    assert.equal(state.calls.length, 0);
  });
}
for (const [field, value] of [
  ["artifactId", "../injected"],
  ["archiveSha256", null],
  ["stateSha256", "xyz"],
  ["expiresAt", "2026-11-05T18:00:00.000Z"],
  ["extra", true],
]) {
  test(`refuses unavailable or unbounded baseline ${field}`, async () => {
    const { journal, state } = fixture();
    const changed = input();
    changed.baseline[field] = value;
    await refuses(() => journal.begin(changed));
    assert.equal(state.calls.length, 0);
  });
}
for (const [field, value] of [
  ["schema", "other"],
  ["q", "0".repeat(64)],
  ["deploymentId", "2"],
  ["baselineStateSha256", "0".repeat(64)],
  ["providerStateSha256", "0".repeat(64)],
  ["smokeSha256", "pass"],
  ["nextUploadSha256", null],
  ["extra", true],
  ["verifiedAt", "2026-11-04T17:59:59.000Z"],
  ["verifiedAt", "2026-11-04T18:01:00.000Z"],
]) {
  test(`refuses mismatched, stale or malformed restoration ${field}`, async () => {
    const { journal, state } = fixture();
    state.rows.push(deployment());
    const changed = proof();
    changed[field] = value;
    await refuses(() => journal.markRestored("1", changed));
    assert.equal(state.calls.filter((call) => call.method === "POST").length, 0);
    await refuses(() => journal.assertClear());
  });
}

for (const [field, value] of [
  ["id", 0],
  ["creator", { id: 9 }],
  ["performed_via_github_app", { id: 9 }],
  ["environment", "production"],
  ["task", "deploy"],
  ["production_environment", true],
  ["transient_environment", true],
  ["sha", "0".repeat(40)],
  ["ref", "main"],
  ["payload", {}],
]) {
  test(`malformed or foreign durable ${field} is a refusal, not empty occupancy`, async () => {
    const { journal, state } = fixture();
    const changed = deployment();
    changed[field] = value;
    state.rows.push(changed);
    await refuses(() => journal.assertClear());
    await refuses(() => journal.begin(input()));
    assert.equal(state.calls.filter((call) => call.method === "POST").length, 0);
  });
}

for (const values of [
  {},
  [status("success", 0)],
  [status("success", 2), status("success", 2)],
  [status("success", 2), status("success", 3)],
  [{ ...status(), creator: { id: 9 } }],
  [{ ...status(), performed_via_github_app: { id: 9 } }],
  [{ ...status(), environment: "production" }],
  [{ ...status(), description: "green" }],
  [{ ...status(), state: "unknown" }],
]) {
  test(`malformed status list refuses ${JSON.stringify(values)}`, async () => {
    const { journal, state } = fixture();
    state.rows.push(deployment());
    state.statuses.set(1, values);
    await refuses(() => journal.assertClear());
  });
}

test("unfiltered deployment pagination reads the terminal page and cannot hide an older dirty run", async () => {
  const { journal, state } = fixture();
  state.rows = Array.from({ length: 101 }, (_, index) => deployment(index + 1));
  for (let id = 1; id <= 100; id++) state.statuses.set(id, [status()]);
  const dirty = await journal.unresolved();
  assert.deepEqual(
    dirty.map((row) => row.id),
    [101],
  );
  assert.ok(state.calls.some((call) => call.url.endsWith("&page=2")));
  await refuses(() => journal.assertClear());
});

test("exactly 500 records require an empty sentinel page; 501 refuses", async () => {
  const { journal, state } = fixture();
  state.rows = Array.from({ length: 500 }, (_, index) => deployment(index + 1));
  for (let id = 1; id <= 500; id++) state.statuses.set(id, [status()]);
  await journal.assertClear();
  assert.ok(state.calls.some((call) => call.url.endsWith("&page=6")));
  state.rows.push(deployment(501));
  await refuses(() => journal.assertClear());
});

test("duplicate deployment pages fail closed", async () => {
  const { journal, state } = fixture();
  state.rows = [deployment(), deployment()];
  await refuses(() => journal.assertClear());
});

test("a competing dirty record discovered after creation withholds admission", async () => {
  const { journal, state } = fixture();
  state.intercept = ({ url }) => {
    if (url.includes("/deployments?") && state.rows.length === 1) state.rows.push(deployment(99));
  };
  await refuses(() => journal.begin(input()));
  assert.equal(state.rows.length, 2);
  await refuses(() => journal.assertClear());
});

test("lost create response is not retried; next process discovers persistent dirty occupancy", async () => {
  const { journal, state, fetchImpl } = fixture();
  state.intercept = ({ method, body, url }) => {
    if (method === "POST" && url === `${BASE}/deployments`) {
      state.rows.push(deployment(1, body.payload));
      throw new Error("private-data injected fixture-only");
    }
  };
  await refuses(() => journal.begin(input()));
  assert.equal(state.calls.filter((call) => call.method === "POST").length, 1);
  const next = createCandidateStagingJournal({
    token: "fixture-only",
    creatorId: "7",
    appId: "8",
    fetchImpl,
    now: () => NOW,
  });
  await refuses(() => next.assertClear());
});

for (const code of [201, 301, 401, 403, 429, 500]) {
  test(`HTTP ${code} is redacted and never retries with another credential`, async () => {
    const { journal, state } = fixture();
    state.intercept = () =>
      Response.json({ message: "private-data injected fixture-only" }, { status: code });
    await refuses(() => journal.assertClear());
    assert.equal(state.calls.length, 1);
  });
}
for (const [body, headers] of [
  ["not JSON", { "content-type": "application/json" }],
  ["{}", { "content-type": "text/html" }],
  ["[]", { "content-type": "application/json", "content-length": "999999999" }],
  ["[]", { "content-type": "application/json", "content-length": "-1" }],
  ["x".repeat(2 * 1024 * 1024 + 1), { "content-type": "application/json" }],
]) {
  test(`HTTP body bounds refuse ${headers["content-type"]}/${body.length}`, async () => {
    const { journal, state } = fixture();
    state.intercept = () => new Response(body, { headers });
    await refuses(() => journal.assertClear());
  });
}

test("failed status publication leaves dirty; successful write with lost response is recoverable by read", async () => {
  const { journal, state } = fixture();
  state.rows.push(deployment());
  state.intercept = ({ method }) =>
    method === "POST" ? Response.json({}, { status: 403 }) : undefined;
  await refuses(() => journal.markRestored("1", proof()));
  await refuses(() => journal.assertClear());
  state.intercept = ({ method, body }) => {
    if (method === "POST") {
      state.statuses.set(1, [{ id: 100, ...author, ...body }]);
      throw new Error("lost response");
    }
  };
  await refuses(() => journal.markRestored("1", proof()));
  await journal.assertClear();
});

test("capacity refuses before dirty creation rather than stranding recovery record 501", async () => {
  const { journal, state } = fixture();
  state.rows = Array.from({ length: 500 }, (_, index) => {
    const value = input();
    value.q = index.toString(16).padStart(64, "0");
    state.statuses.set(index + 1, [status()]);
    return deployment(index + 1, value);
  });
  await journal.assertClear();
  await refuses(() => journal.begin(input()));
  assert.equal(state.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(state.rows.length, 500);
  await journal.assertClear();
});

for (const method of ["unresolved", "requireDirty"]) {
  test(`caller cancellation cannot remove ${method} operation deadline`, async (t) => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const timeouts = [];
    t.mock.method(AbortSignal, "timeout", (milliseconds) => {
      timeouts.push(milliseconds);
      return original(milliseconds === 60_000 ? 10 : 1000);
    });
    const { journal, state } = fixture();
    state.intercept = async (_request, options) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      options.signal.throwIfAborted();
    };
    const signal = new AbortController().signal;
    await refuses(() =>
      method === "unresolved" ? journal.unresolved(signal) : journal.requireDirty("1", signal),
    );
    assert.ok(timeouts.includes(60_000));
    assert.equal(state.calls.length, 1);
    assert.equal(signal.aborted, false);
  });
}

test("clean session Q cannot be replayed", async () => {
  const { journal, state } = fixture();
  const row = await journal.begin(input());
  await journal.markRestored(String(row.id), proof(row));
  const count = state.calls.filter((call) => call.method === "POST").length;
  await refuses(() => journal.begin(input()));
  assert.equal(state.calls.filter((call) => call.method === "POST").length, count);
});

test("GitHub JSON property ordering does not alter immutable payload identity", async () => {
  const { journal, state } = fixture();
  state.intercept = ({ method, url, body }) => {
    if (method === "POST" && url === `${BASE}/deployments`) {
      const value = Object.fromEntries(Object.entries(body.payload).reverse());
      value.baseline = Object.fromEntries(Object.entries(value.baseline).reverse());
      const row = deployment(1, value);
      state.rows.push(row);
      return Response.json(row, { status: 201 });
    }
  };
  assert.equal((await journal.begin(input())).id, 1);
});

test("status pagination cannot hide a later page or silently truncate status history", async () => {
  const { journal, state } = fixture();
  state.rows.push(deployment());
  state.statuses.set(
    1,
    Array.from({ length: 101 }, (_, index) => status("success", 200 - index)),
  );
  await journal.assertClear();
  assert.ok(
    state.calls.some((call) => call.url.includes("/statuses?") && call.url.endsWith("page=2")),
  );
  state.statuses.get(1)[100] = status("failure", 1000);
  await refuses(() => journal.assertClear());
  state.statuses.set(
    1,
    Array.from({ length: 501 }, (_, index) => status("success", 1000 - index)),
  );
  await refuses(() => journal.assertClear());
});

test("replaced clean receipt withholds success even when the new status is also green", async () => {
  const { journal, state } = fixture();
  state.rows.push(deployment());
  state.intercept = ({ method, url }) => {
    if (method === "GET" && url.includes("/statuses?") && state.statuses.has(1)) {
      return Response.json([status("success", 2000), ...state.statuses.get(1)]);
    }
  };
  await refuses(() => journal.markRestored("1", proof()));
});

test("a new dirty session during restoration publication withholds success", async () => {
  const { journal, state } = fixture();
  state.rows.push(deployment());
  state.intercept = ({ method }) => {
    if (method === "POST") state.rows.push(deployment(2));
  };
  await refuses(() => journal.markRestored("1", proof()));
});

test("an aborted operation refuses before network; no alternate credential is tried", async () => {
  const { journal, state } = fixture();
  await refuses(() => journal.unresolved(AbortSignal.abort()));
  assert.equal(state.calls.length, 0);
});

test("adapter failure cannot leak raw provider errors", async () => {
  const { journal, state } = fixture();
  state.rows.push(deployment());
  await refuses(() =>
    recoverCandidateStaging({
      journal,
      deploymentId: "1",
      assertExclusive: async () => {},
      restore: async () => {
        throw new Error("private-data injected fixture-only");
      },
      verify: async () => proof(),
    }),
  );
});

test("clean status readback must observe latest success", async () => {
  const { journal, state } = fixture();
  state.rows.push(deployment());
  state.intercept = ({ method, url }) => {
    if (method === "GET" && url.includes("/statuses?") && state.statuses.has(1)) {
      return Response.json([status("failure", 2000), ...state.statuses.get(1)]);
    }
  };
  await refuses(() => journal.markRestored("1", proof()));
});
