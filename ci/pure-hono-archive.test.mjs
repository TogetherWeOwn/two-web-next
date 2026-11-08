import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { downloadPureHonoArchive } from "./pure-hono-archive.mjs";

const SHA = "a".repeat(40);
const REPO = "TogetherWeOwn/two-web-next";
const WORKFLOW = ".github/workflows/deploy-production.yml";
const API = `https://api.github.com/repos/${REPO}/actions`;
const RUN_URL = `https://github.com/${REPO}/actions/runs/123`;
const ARTIFACT_NAME = `worker-bundle-production-${SHA}-123-1`;
const SIGNED = "https://productionresults.blob.core.windows.net/artifact/zip?sig=SECRETSIG";
const TOKEN = "ghs_secret_token_value";
const FAILURE = "pure-Hono archive download failed";
const BODY = Buffer.from("PK-archive-bytes-not-unzipped");
const DIGEST = `sha256:${createHash("sha256").update(BODY).digest("hex")}`;

const pointer = { runId: "123", runAttempt: "1", sourceSha: SHA };
const makeRun = (overrides = {}) => ({
  id: 123,
  run_attempt: 1,
  head_sha: SHA,
  repository: { id: 42, full_name: REPO },
  head_repository: { id: 42, full_name: REPO },
  path: WORKFLOW,
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  html_url: RUN_URL,
  ...overrides,
});
const makeArtifact = (overrides = {}) => ({
  id: 456,
  name: ARTIFACT_NAME,
  expired: false,
  size_in_bytes: BODY.length,
  digest: DIGEST,
  workflow_run: {
    id: 123,
    head_sha: SHA,
    head_branch: "main",
    repository_id: 42,
    head_repository_id: 42,
  },
  ...overrides,
});

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const redirect = (location, status = 302) =>
  new Response(null, { status, headers: location === null ? {} : { location } });

// Routes map "METHOD url" to a Response or a function returning one.
const makeFetch = (routes) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = String(url);
    calls.push({ url: key, init });
    const route = routes[key];
    if (route === undefined) return new Response("unexpected", { status: 500 });
    return typeof route === "function" ? route(init) : route;
  };
  return { fetchImpl, calls };
};
const happyRoutes = (over = {}) => ({
  [`${API}/runs/123`]: json(makeRun()),
  [`${API}/artifacts/456`]: json(makeArtifact()),
  [`${API}/artifacts/456/zip`]: redirect(SIGNED),
  [SIGNED]: new Response(BODY, { status: 200 }),
  ...over,
});

const authOf = (init) => new Headers(init?.headers).get("authorization");

describe("downloadPureHonoArchive", () => {
  let dir;
  let destination;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pure-hono-archive-"));
    destination = join(dir, "archive.zip");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (routes, options = {}) => {
    const { fetchImpl, calls } = makeFetch(routes);
    const promise = () =>
      downloadPureHonoArchive(pointer, {
        artifactId: "456",
        token: TOKEN,
        destination,
        fetchImpl,
        ...options,
      });
    return { promise, calls };
  };
  const rejectsSanitized = async (routes, options) => {
    const { promise, calls } = run(routes, options);
    await assert.rejects(promise(), (error) => {
      assert.equal(error.message, FAILURE);
      const text = `${error.message}${error.stack ?? ""}${String(error.cause ?? "")}`;
      assert.ok(!text.includes(TOKEN));
      assert.ok(!text.includes("SECRETSIG"));
      return true;
    });
    assert.equal(existsSync(destination), false, "no file written on failure");
    return calls;
  };

  test("downloads, verifies and writes the archive", async () => {
    const { promise, calls } = run(happyRoutes());
    const result = await promise();
    assert.equal(result.archiveSha256, DIGEST.slice("sha256:".length));
    assert.equal(result.archiveBytes, BODY.length);
    assert.equal(result.provenance.runId, "123");
    assert.equal(result.provenance.artifactId, "456");
    assert.equal(result.provenance.artifactName, ARTIFACT_NAME);
    assert.deepEqual(readFileSync(destination), BODY);
    assert.deepEqual(
      calls.map((call) => call.url),
      [`${API}/runs/123`, `${API}/artifacts/456`, `${API}/artifacts/456/zip`, SIGNED],
    );
  });

  test("authenticates only the GitHub API calls and never follows redirects", async () => {
    const { promise, calls } = run(happyRoutes());
    await promise();
    for (const call of calls.slice(0, 3)) {
      assert.equal(authOf(call.init), `Bearer ${TOKEN}`);
    }
    assert.equal(calls[2].init.redirect, "manual");
    const signed = calls[3];
    assert.equal(authOf(signed.init), null);
    assert.equal(signed.init.redirect, "error");
    assert.ok(!JSON.stringify(signed.init).includes(TOKEN));
  });

  for (const host of [
    "https://results-receiver.actions.githubusercontent.com/a?sig=SECRETSIG",
    "https://abc123.blob.core.windows.net/a?sig=SECRETSIG",
  ]) {
    test(`accepts signed host ${new URL(host).host}`, async () => {
      const { promise } = run(
        happyRoutes({
          [`${API}/artifacts/456/zip`]: redirect(host),
          [host]: new Response(BODY),
        }),
      );
      assert.equal((await promise()).archiveBytes, BODY.length);
    });
  }

  for (const [name, input] of Object.entries({
    "empty id": "",
    "zero id": "0",
    "negative id": "-1",
    "leading zero id": "0456",
    "decimal id": "4.5",
    "path id": "456/zip",
    "hex id": "0x1c8",
    "numeric id": 456,
    "21 digit id": "1".repeat(21),
  })) {
    test(`rejects invalid artifactId before network: ${name}`, async () => {
      const calls = await rejectsSanitized(happyRoutes(), { artifactId: input });
      assert.equal(calls.length, 0);
    });
  }

  for (const [name, bad] of Object.entries({
    "bad runId": { ...pointer, runId: "12x" },
    "zero attempt": { ...pointer, runAttempt: "0" },
    "short sha": { ...pointer, sourceSha: "abc" },
    "uppercase sha": { ...pointer, sourceSha: "A".repeat(40) },
    "missing pointer": null,
  })) {
    test(`rejects invalid pointer before network: ${name}`, async () => {
      const { fetchImpl, calls } = makeFetch(happyRoutes());
      await assert.rejects(
        downloadPureHonoArchive(bad, {
          artifactId: "456",
          token: TOKEN,
          destination,
          fetchImpl,
        }),
        (error) => error.message === FAILURE,
      );
      assert.equal(calls.length, 0);
      assert.equal(existsSync(destination), false);
    });
  }

  for (const [name, token] of Object.entries({
    empty: "",
    missing: undefined,
    "non-string": 12345,
    "carriage return": "ghs_abc\rdef",
    "line feed": "ghs_abc\ndef",
    "over 16 KiB": "t".repeat(16 * 1024 + 1),
  })) {
    test(`rejects invalid token before network: ${name}`, async () => {
      const calls = await rejectsSanitized(happyRoutes(), { token });
      assert.equal(calls.length, 0);
    });
  }

  test("accepts a token of exactly 16 KiB", async () => {
    const { promise } = run(happyRoutes(), { token: "t".repeat(16 * 1024) });
    assert.equal((await promise()).archiveBytes, BODY.length);
  });

  const runCases = {
    "wrong run": { id: 124 },
    "wrong branch": { head_branch: "feature" },
    "untrusted event": { event: "pull_request" },
    "fork producer": { head_repository: { id: 99, full_name: "evil/two-web-next" } },
    "failed run": { conclusion: "failure" },
    "unfinished run": { status: "in_progress", conclusion: null },
    "wrong workflow": { path: ".github/workflows/other.yml" },
  };
  for (const [name, change] of Object.entries(runCases)) {
    test(`rejects ${name} without downloading`, async () => {
      const calls = await rejectsSanitized(
        happyRoutes({ [`${API}/runs/123`]: json(makeRun(change)) }),
      );
      assert.ok(!calls.some((call) => call.url.endsWith("/zip")));
    });
  }

  const artifactCases = {
    expired: { expired: true },
    "wrong name": { name: "worker-bundle-production-other" },
    "wrong artifact branch": {
      workflow_run: { ...makeArtifact().workflow_run, head_branch: "feature" },
    },
    "fork artifact": {
      workflow_run: { ...makeArtifact().workflow_run, head_repository_id: 99 },
    },
    "missing digest": { digest: undefined },
    "malformed digest": { digest: "sha256:abc" },
    "uppercase digest": { digest: `sha256:${"A".repeat(64)}` },
    "wrong digest algorithm": { digest: `sha1:${"a".repeat(64)}` },
    "mismatching digest": { digest: `sha256:${"b".repeat(64)}` },
    "zero size": { size_in_bytes: 0 },
    "size smaller than actual": { size_in_bytes: BODY.length - 1 },
    "size larger than actual": { size_in_bytes: BODY.length + 1 },
    "oversize metadata": { size_in_bytes: 64 * 1024 * 1024 + 1 },
  };
  for (const [name, change] of Object.entries(artifactCases)) {
    test(`rejects artifact: ${name}`, async () => {
      await rejectsSanitized(
        happyRoutes({ [`${API}/artifacts/456`]: json(makeArtifact(change)) }),
      );
    });
  }

  test("rejects an artifact ID that differs from the metadata", async () => {
    await rejectsSanitized(
      happyRoutes({ [`${API}/artifacts/456`]: json(makeArtifact({ id: 457 })) }),
    );
  });

  test("rejects an oversize JSON response", async () => {
    const big = new Response(" ".repeat(2 * 1024 * 1024 + 1) + JSON.stringify(makeRun()));
    await rejectsSanitized(happyRoutes({ [`${API}/runs/123`]: big }));
  });

  test("rejects an oversize archive body by the actual stream limit", async () => {
    const body = new Response(new Uint8Array(64 * 1024 * 1024 + 1));
    const calls = await rejectsSanitized(happyRoutes({ [SIGNED]: body }));
    assert.ok(calls.some((call) => call.url === SIGNED), "signed stage reached");
  });

  const withLength = (body, headers) => new Response(body, { status: 200, headers });

  test("rejects a declared content-length above the limit", async () => {
    const calls = await rejectsSanitized(
      happyRoutes({
        [SIGNED]: withLength(BODY, { "content-length": String(64 * 1024 * 1024 + 1) }),
      }),
    );
    assert.ok(calls.some((call) => call.url === SIGNED), "signed stage reached");
  });

  test("rejects an identity body differing from its content-length", async () => {
    const calls = await rejectsSanitized(
      happyRoutes({
        [SIGNED]: withLength(BODY, { "content-length": String(BODY.length + 1) }),
      }),
    );
    assert.ok(calls.some((call) => call.url === SIGNED), "signed stage reached");
  });

  for (const declared of ["abc", "-1", "1.5", "1e3", "0x10", "12, 12"]) {
    test(`rejects malformed content-length ${JSON.stringify(declared)}`, async () => {
      const calls = await rejectsSanitized(
        happyRoutes({ [SIGNED]: withLength(BODY, { "content-length": declared }) }),
      );
      assert.ok(calls.some((call) => call.url === SIGNED), "signed stage reached");
    });
  }

  test("accepts a gzip response whose decompressed bytes match metadata", async () => {
    // The mock body stands for the bytes fetch already decompressed.
    const { promise } = run(
      happyRoutes({
        [SIGNED]: withLength(BODY, { "content-length": "1", "content-encoding": "gzip" }),
      }),
    );
    const result = await promise();
    assert.equal(result.archiveBytes, BODY.length);
    assert.deepEqual(readFileSync(destination), BODY);
  });

  test("rejects archive bytes that do not match the digest", async () => {
    await rejectsSanitized(
      happyRoutes({ [SIGNED]: new Response(Buffer.from("tampered-archive-bytes!!!!!")) }),
    );
  });

  const locations = {
    "http scheme": "http://productionresults.blob.core.windows.net/a",
    "credentials": "https://user:pw@productionresults.blob.core.windows.net/a",
    "nonstandard port": "https://productionresults.blob.core.windows.net:8443/a",
    "hash fragment": "https://productionresults.blob.core.windows.net/a#frag",
    "unrelated host": "https://evil.example.com/a",
    "arbitrary actions subdomain":
      "https://pipelines.actions.githubusercontent.com/a?sig=SECRETSIG",
    "github api host": "https://api.github.com/repos/x",
    "suffix lookalike": "https://evil.blob.core.windows.net.evil.com/a",
    "prefix lookalike": "https://evilactions.githubusercontent.com/a",
    "bare actions host": "https://actions.githubusercontent.com/a",
    "blob apex": "https://blob.core.windows.net/a",
    "nested blob host": "https://a.b.blob.core.windows.net/a",
    "relative location": "/relative/path",
    "garbage location": "not a url",
    "empty location": "",
  };
  for (const [name, location] of Object.entries(locations)) {
    test(`rejects hostile redirect location: ${name}`, async () => {
      const calls = await rejectsSanitized(
        happyRoutes({ [`${API}/artifacts/456/zip`]: redirect(location) }),
      );
      assert.ok(
        calls.every((call) => call.url.startsWith(API)),
        "signed fetch never attempted",
      );
    });
  }

  test("rejects a missing redirect location", async () => {
    await rejectsSanitized(happyRoutes({ [`${API}/artifacts/456/zip`]: redirect(null) }));
  });

  for (const status of [200, 301, 303, 307, 308]) {
    test(`requires a 302 from the zip endpoint, not ${status}`, async () => {
      const response =
        status === 200 ? new Response(BODY, { status }) : redirect(SIGNED, status);
      await rejectsSanitized(happyRoutes({ [`${API}/artifacts/456/zip`]: response }));
    });
  }

  test("does not follow a redirect from the signed host", async () => {
    const calls = await rejectsSanitized(
      happyRoutes({
        [SIGNED]: redirect("https://productionresults.blob.core.windows.net/other"),
      }),
    );
    assert.equal(calls.filter((call) => call.url === SIGNED).length, 1);
    assert.equal(calls.length, 4);
  });

  for (const status of [400, 401, 403, 404, 410, 429]) {
    for (const stage of ["run", "artifact", "zip", "signed"]) {
      test(`fails without retry on ${status} at ${stage}`, async () => {
        const target = {
          run: `${API}/runs/123`,
          artifact: `${API}/artifacts/456`,
          zip: `${API}/artifacts/456/zip`,
          signed: SIGNED,
        }[stage];
        const body = `native body ${TOKEN} SECRETSIG`;
        const calls = await rejectsSanitized(
          happyRoutes({ [target]: new Response(body, { status }) }),
        );
        assert.equal(calls.filter((call) => call.url === target).length, 1);
      });
    }
  }

  test("sanitizes network errors", async () => {
    const fetchImpl = async (url) => {
      throw new Error(`connect failed ${url} ${TOKEN} SECRETSIG`);
    };
    await assert.rejects(
      downloadPureHonoArchive(pointer, {
        artifactId: "456",
        token: TOKEN,
        destination,
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.message, FAILURE);
        assert.ok(!`${error.stack}`.includes(TOKEN));
        assert.ok(!`${error.stack}`.includes("SECRETSIG"));
        return true;
      },
    );
    assert.equal(existsSync(destination), false);
  });

  test("sanitizes a network error on the signed download", async () => {
    const { fetchImpl } = makeFetch(happyRoutes());
    const failing = async (url, init) => {
      if (String(url) === SIGNED) throw new Error(`reset ${url}`);
      return fetchImpl(url, init);
    };
    await assert.rejects(
      downloadPureHonoArchive(pointer, {
        artifactId: "456",
        token: TOKEN,
        destination,
        fetchImpl: failing,
      }),
      (error) => error.message === FAILURE && !`${error.stack}`.includes("SECRETSIG"),
    );
  });

  test("refuses to overwrite an existing destination", async () => {
    writeFileSync(destination, "keep me");
    const { promise } = run(happyRoutes());
    await assert.rejects(promise(), (error) => error.message === FAILURE);
    assert.equal(readFileSync(destination, "utf8"), "keep me");
  });

  test("does not create the destination when provenance fails", async () => {
    await rejectsSanitized(
      happyRoutes({ [`${API}/runs/123`]: json(makeRun({ head_branch: "feature" })) }),
    );
  });
});
