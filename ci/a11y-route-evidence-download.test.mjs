import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ROUTE_EVIDENCE_ZIP_LIMITS } from "./route-evidence-artifact-zip.mjs";
import { createRouteEvidenceDownload } from "./route-evidence-download.mjs";

// Stored ZIP with a single report.json entry containing {"a":1}.
const zip = Buffer.from(
  "UEsDBBQAAAAAAAAAIQCvrBtWBwAAAAcAAAALAAAAcmVwb3J0Lmpzb257ImEiOjF9UEsBAhQAFAAAAAAAAAAhAK+sG1YHAAAABwAAAAsAAAAAAAAAAAAAAIABAAAAAHJlcG9ydC5qc29uUEsFBgAAAAABAAEAOQAAADAAAAAAAA==",
  "base64",
);
const expectedDigest = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
const storageUrl = "https://storage.blob.core.windows.net/container/archive?signature=fixture";
const refused = /^Error: route evidence refused: artifact download unavailable$/;
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });

function transport(api, storage) {
  const calls = [];
  const download = createRouteEvidenceDownload("owner/repo", "test-token", async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? api : storage(options.signal);
  });
  return { download, calls };
}

test("downloads the exact artifact with API credentials and extracts the verified ZIP", async () => {
  const { download, calls } = transport(redirect(storageUrl), () => new Response(zip));
  const entries = await download(42, expectedDigest);
  assert.deepEqual(entries, new Map([["report.json", Buffer.from('{"a":1}')]]));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/actions/artifacts/42/zip");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].url, storageUrl);
  assert.deepEqual(calls[1].options, {
    credentials: "omit",
    redirect: "error",
    signal: calls[0].options.signal,
  });
});

test("refuses invalid repository and artifact coordinates before any fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error("unexpected fetch");
  };
  for (const repository of ["https://example.com/a", "owner/..", "./repo", "owner/repo?next=x"]) {
    assert.throws(
      () => createRouteEvidenceDownload(repository, "test-token", fetchImpl),
      /invalid download configuration/,
    );
  }
  const download = createRouteEvidenceDownload("owner/repo", "test-token", fetchImpl);
  for (const id of [0, -1, 1.5, "42", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(download(id, expectedDigest), /invalid artifact ID/);
  }
  assert.equal(calls, 0);
});

test("refuses unsafe redirects and never follows a second redirect", async () => {
  for (const api of [
    redirect("http://storage.blob.core.windows.net/x"),
    redirect("https://example.com/x"),
    redirect("https://storage.blob.core.windows.net.evil.test/x"),
    redirect("https://user@storage.blob.core.windows.net/x"),
    redirect("https://storage.blob.core.windows.net:444/x"),
    redirect("/relative.zip"),
    redirect(storageUrl, 307),
    new Response(null, { status: 302 }),
  ]) {
    const { download, calls } = transport(api);
    await assert.rejects(download(42, expectedDigest), refused);
    assert.equal(calls.length, 1);
  }
  const { download, calls } = transport(redirect(storageUrl), () => redirect(storageUrl));
  await assert.rejects(download(42, expectedDigest), refused);
  assert.equal(calls.length, 2);
});

test("refuses interrupted, oversized and digest-mismatched downloads without leaking details", async () => {
  let reads = 0;
  const interrupted = new ReadableStream({
    pull(controller) {
      if (++reads === 1) controller.enqueue(zip.subarray(0, 10));
      else controller.error(new Error("signature=fixture"));
    },
  });
  let reachedEnd = false;
  const oversized = {
    ok: true,
    body: (async function* () {
      yield new Uint8Array(ROUTE_EVIDENCE_ZIP_LIMITS.maxArchiveBytes);
      yield Uint8Array.of(1);
      reachedEnd = true;
    })(),
  };
  for (const [response, digest] of [
    [new Response(interrupted), expectedDigest],
    [oversized, expectedDigest],
    [new Response(zip), `sha256:${"0".repeat(64)}`],
    [new Response(zip), undefined],
  ]) {
    const { download, calls } = transport(redirect(storageUrl), () => response);
    await assert.rejects(download(42, digest), refused);
    assert.equal(calls.length, 2);
  }
  assert.equal(reads, 2);
  assert.equal(reachedEnd, false);
  const download = createRouteEvidenceDownload("owner/repo", "test-token", async () => {
    throw new Error("Bearer test-token");
  });
  await assert.rejects(download(42, expectedDigest), refused);
});

test("shares one deadline across the API request and storage body read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = Promise.withResolvers();
  let signal;
  const download = createRouteEvidenceDownload(
    "owner/repo",
    "test-token",
    async (_url, options) => {
      if (!signal) {
        signal = options.signal;
        t.mock.timers.tick(4_000);
        return redirect(storageUrl);
      }
      return new Response(
        new ReadableStream(
          {
            start(controller) {
              options.signal.addEventListener(
                "abort",
                () => controller.error(options.signal.reason),
                {
                  once: true,
                },
              );
            },
            pull() {
              reading.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  );
  const rejection = assert.rejects(download(42, expectedDigest), refused);
  await reading.promise;
  t.mock.timers.tick(5_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await rejection;
});
