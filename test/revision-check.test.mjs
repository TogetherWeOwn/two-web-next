import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { readRevision, verifyRevision } from "../bin/revision-check.mjs";

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
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/up" ? JSON.stringify(body) : "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const cli = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/revision-check.mjs", ...args], {
      env: { PATH: process.env.PATH },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

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

test("CLI rejects a missing origin, an extra argument and a non-SHA commit", () => {
  for (const args of [[], ["http://127.0.0.1:1", "main"], ["http://127.0.0.1:1", COMMIT, "x"]]) {
    const result = spawnSync(process.execPath, ["bin/revision-check.mjs", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node bin\/revision-check\.mjs/);
  }
});
