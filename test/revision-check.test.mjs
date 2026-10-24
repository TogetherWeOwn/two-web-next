import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readRevision, revisionRetryConfig, verifyRevision } from "../bin/revision-check.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const VERSION = "81da0f67-1e2c-4b6e-9a53-0c7c1d2e3f40";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (...responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    return next();
  };
  return { fetchImpl, calls };
};
const quiet = { sleep: async () => {}, log: () => {} };

test("readRevision reads the marker and requests /up without following redirects", async () => {
  const { fetchImpl, calls } = fetchOf(() =>
    json({ status: "healthy", revision: { version_id: VERSION, commit: COMMIT } }),
  );
  assert.deepEqual(await readRevision("https://next.example.test", { fetchImpl }), {
    version_id: VERSION,
    commit: COMMIT,
  });
  assert.equal(calls[0].url, "https://next.example.test/up");
  assert.equal(calls[0].init.redirect, "manual");
});

test("readRevision returns null when /up carries no revision", async () => {
  const { fetchImpl } = fetchOf(() => json({ status: "healthy", db: "ok" }));
  assert.equal(await readRevision("https://next.example.test", { fetchImpl }), null);
});

test("verifyRevision passes when the live commit is the deployed commit, even on a 503", async () => {
  const { fetchImpl } = fetchOf(() =>
    json({ status: "degraded", revision: { version_id: VERSION, commit: COMMIT } }, 503),
  );
  assert.deepEqual(
    await verifyRevision("https://next.example.test", COMMIT, { fetchImpl, ...quiet }),
    {
      version_id: VERSION,
      commit: COMMIT,
    },
  );
});

test("verifyRevision retries while the old Version still serves, then passes", async () => {
  const { fetchImpl, calls } = fetchOf(
    () => json({ revision: { version_id: VERSION, commit: OTHER } }),
    () => json({ status: "healthy" }),
    new Error("network down"),
    () => json({ revision: { version_id: VERSION, commit: COMMIT } }),
  );
  const revision = await verifyRevision("https://next.example.test", COMMIT, {
    fetchImpl,
    ...quiet,
  });
  assert.equal(revision.commit, COMMIT);
  assert.equal(calls.length, 4);
});

test("verifyRevision fails closed after the last attempt and names why", async () => {
  const { fetchImpl, calls } = fetchOf(() =>
    json({ revision: { version_id: VERSION, commit: OTHER } }),
  );
  await assert.rejects(
    verifyRevision("https://next.example.test", COMMIT, { fetchImpl, attempts: 3, ...quiet }),
    new RegExp(`revision.commit is ${OTHER}, expected ${COMMIT}`),
  );
  assert.equal(calls.length, 3);
});

test("verifyRevision rejects an untagged or malformed marker", async () => {
  for (const revision of [
    { version_id: VERSION, commit: null },
    { version_id: "not-a-version-id", commit: COMMIT },
    { version_id: null, commit: COMMIT },
  ]) {
    const { fetchImpl } = fetchOf(() => json({ revision }));
    await assert.rejects(
      verifyRevision("https://next.example.test", COMMIT, { fetchImpl, attempts: 1, ...quiet }),
    );
  }
});

async function withServer(body, run) {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/up" ? JSON.stringify(body) : "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, () => hits);
  } finally {
    server.close();
  }
}
const cliWithEnv = (args, envExtra = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/revision-check.mjs", ...args], {
      env: { PATH: process.env.PATH, ...envExtra },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
const cli = (...args) => cliWithEnv(args, {});
const FAST_RETRY = { REVISION_CHECK_ATTEMPTS: "1", REVISION_CHECK_DELAY_MS: "0" };

test("CLI record mode prints the live Version ID and never fails, marker or not", async () => {
  await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin) => {
    const result = await cli(origin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`version \`${VERSION}\`.*commit \`${COMMIT}\``));
  });
  await withServer({ status: "healthy" }, async (origin) => {
    const result = await cli(origin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no revision marker/);
  });
  const unreachable = await cli("http://127.0.0.1:1");
  assert.equal(unreachable.status, 0);
  assert.match(unreachable.stdout, /unreadable/);
});

test("CLI verify mode exits 0 on the deployed commit", async () => {
  await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin) => {
    const result = await cli(origin, COMMIT);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Deployed revision verified/);
  });
});

test("CLI human verify failure exits 1 after the configured attempts", async () => {
  await withServer({ revision: { version_id: VERSION, commit: OTHER } }, async (origin, hits) => {
    const result = await cliWithEnv([origin, COMMIT], {
      ...FAST_RETRY,
      REVISION_CHECK_ATTEMPTS: "2",
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      `revision-check: /up revision.commit is ${OTHER}, expected ${COMMIT}\n`,
    );
    assert.match(result.stdout, /revision attempt 1\/2:/);
    assert.match(result.stdout, /revision attempt 2\/2:/);
    assert.doesNotMatch(result.stdout, /Deployed revision verified/);
    assert.equal(hits(), 2);
  });
});

test("CLI rejects a missing origin, an extra argument and a non-SHA commit", () => {
  for (const args of [[], ["http://127.0.0.1:1", "main"], ["http://127.0.0.1:1", COMMIT, "x"]]) {
    const result = spawnSync(process.execPath, ["bin/revision-check.mjs", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node bin\/revision-check\.mjs/);
  }
});

test("CLI fires through a symlinked invocation instead of exiting 0 silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "revision-check-guard-"));
  const link = join(dir, "link-check.mjs");
  symlinkSync(resolve("bin/revision-check.mjs"), link);
  try {
    const result = await new Promise((done) => {
      const child = spawn(process.execPath, [link], {
        env: { PATH: process.env.PATH },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node bin\/revision-check\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revisionRetryConfig defaults to production retries and validates overrides", () => {
  assert.deepEqual(revisionRetryConfig({}), { attempts: 6, delayMs: 10_000 });
  assert.deepEqual(
    revisionRetryConfig({ REVISION_CHECK_ATTEMPTS: "1", REVISION_CHECK_DELAY_MS: "0" }),
    { attempts: 1, delayMs: 0 },
  );
  // Invalid values fall back instead of weakening or stalling the deploy gate.
  for (const env of [
    { REVISION_CHECK_ATTEMPTS: "0", REVISION_CHECK_DELAY_MS: "-1" },
    { REVISION_CHECK_ATTEMPTS: "99", REVISION_CHECK_DELAY_MS: "99999" },
    { REVISION_CHECK_ATTEMPTS: "x", REVISION_CHECK_DELAY_MS: "y" },
    { REVISION_CHECK_ATTEMPTS: "1oops", REVISION_CHECK_DELAY_MS: "0oops" },
    { REVISION_CHECK_ATTEMPTS: "1e3", REVISION_CHECK_DELAY_MS: "2e3" },
  ]) {
    assert.deepEqual(revisionRetryConfig(env), { attempts: 6, delayMs: 10_000 });
  }
});

test("CLI human and JSON verify retain six attempts for a malformed retry override", async () => {
  for (const flags of [[], ["--json"]]) {
    await withServer({ revision: { version_id: VERSION, commit: OTHER } }, async (origin, hits) => {
      const result = await cliWithEnv([origin, COMMIT, ...flags], {
        ...FAST_RETRY,
        REVISION_CHECK_ATTEMPTS: "1oops",
      });
      assert.equal(result.status, 1);
      assert.equal(hits(), 6);
    });
  }
});

test("CLI --json verify success pins expected_commit and the exact stable code", async () => {
  await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin) => {
    const result = await cliWithEnv([origin, COMMIT, "--json"], FAST_RETRY);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.version, 1);
    assert.equal(verdict.mode, "verify");
    assert.equal(verdict.commit, COMMIT);
    assert.equal(verdict.expected_commit, COMMIT);
    assert.equal(verdict.verified, true);
    assert.equal(verdict.code, "verify.verified");
    assert.equal(typeof verdict.next_action, "string");
    assert.ok(verdict.next_action.length > 0);
  });
});

test("CLI --json verify failure reports null commit plus expected_commit with exact codes", async () => {
  const cases = [
    {
      name: "mismatch",
      body: { revision: { version_id: VERSION, commit: OTHER } },
      code: "verify.mismatch",
    },
    { name: "no-marker", body: { status: "healthy" }, code: "verify.no_marker" },
    {
      name: "malformed",
      body: { revision: { version_id: "not-a-version-id", commit: COMMIT } },
      code: "verify.malformed",
    },
  ];
  for (const { name, body, code } of cases) {
    await withServer(body, async (origin) => {
      const result = await cliWithEnv([origin, COMMIT, "--json"], FAST_RETRY);
      assert.equal(result.status, 1, name);
      assert.equal(result.stderr, "", name);
      assert.doesNotMatch(result.stdout, /revision attempt/, name);
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.version, 1, name);
      assert.equal(verdict.mode, "verify", name);
      assert.equal(verdict.commit, null, name);
      assert.equal(verdict.expected_commit, COMMIT, name);
      assert.equal(verdict.verified, false, name);
      assert.equal(verdict.code, code, name);
      assert.ok(verdict.next_action.length > 0, name);
    });
  }
  // Unreachable origin: no server, single fast attempt.
  const unreachable = await cliWithEnv(["http://127.0.0.1:1", COMMIT, "--json"], FAST_RETRY);
  assert.equal(unreachable.status, 1);
  assert.equal(unreachable.stderr, "");
  const verdict = JSON.parse(unreachable.stdout);
  assert.equal(verdict.code, "verify.unreadable");
  assert.equal(verdict.commit, null);
  assert.equal(verdict.expected_commit, COMMIT);
  assert.equal(verdict.verified, false);
});

test("CLI --json record arms pin exact stable codes", async () => {
  const cases = [
    {
      name: "verified",
      body: { revision: { version_id: VERSION, commit: COMMIT } },
      code: "record.verified",
      commit: COMMIT,
      verified: true,
    },
    {
      name: "no-marker",
      body: { status: "healthy" },
      code: "record.no_marker",
      commit: null,
      verified: false,
    },
    {
      name: "malformed-version",
      body: { revision: { version_id: "bad", commit: COMMIT } },
      code: "record.malformed",
      commit: COMMIT,
      verified: false,
    },
    {
      name: "malformed-commit",
      body: { revision: { version_id: VERSION, commit: "zzz" } },
      code: "record.malformed",
      commit: null,
      verified: false,
    },
    {
      name: "null-commit",
      body: { revision: { version_id: VERSION, commit: null } },
      code: "record.malformed",
      commit: null,
      verified: false,
    },
  ];
  for (const { name, body, code, commit, verified } of cases) {
    await withServer(body, async (origin) => {
      const result = await cliWithEnv([origin, "--json"]);
      assert.equal(result.status, 0, name);
      assert.equal(result.stderr, "", name);
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.version, 1, name);
      assert.equal(verdict.mode, "record", name);
      assert.equal(verdict.code, code, name);
      assert.equal(verdict.commit, commit, name);
      assert.equal(verdict.verified, verified, name);
    });
  }
  const unreachable = await cliWithEnv(["http://127.0.0.1:1", "--json"]);
  assert.equal(unreachable.status, 0);
  const verdict = JSON.parse(unreachable.stdout);
  assert.equal(verdict.code, "record.unreadable");
  assert.equal(verdict.commit, null);
  assert.equal(verdict.verified, false);
});

test("CLI rejects unknown flags without probing", async () => {
  await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin, hits) => {
    for (const args of [["--bogus"], [origin, "--bogus"]]) {
      const result = await cliWithEnv(args);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, /Usage: node bin\/revision-check\.mjs/, JSON.stringify(args));
      assert.equal(result.stdout, "", JSON.stringify(args));
    }
    assert.equal(hits(), 0);
  });
});
