import assert from "node:assert/strict";
import { test } from "node:test";
import { githubApi, jobMeasurements, qualityMeasurements } from "./incident-evidence.mjs";

test("numeric quality evidence never copies log URLs, tokens or snippets", () => {
  const log =
    "untrusted https://private.invalid/token secret=DO_NOT_COPY\n" +
    "✘ server-response-time failure for maxNumericValue assertion\n expected: <=600\n found: 660\n" +
    "<member-secret> unrelated text\n";
  assert.deepEqual(qualityMeasurements(log), [
    "server-response-time: threshold <=600; measured 660",
  ]);
  assert.deepEqual(
    qualityMeasurements("secret-audit maxNumericValue\nexpected: <=1\nfound: 2"),
    [],
  );
  assert.doesNotMatch(qualityMeasurements(log).join("\n"), /private|DO_NOT_COPY|member/);
});

test("API pins host, refuses redirects and never includes remote error bodies", async () => {
  let options;
  const api = githubApi("fixture", async (url, init) => {
    assert.equal(new URL(url).hostname, "api.github.com");
    options = init;
    return new Response("secret server body", { status: 403 });
  });
  await assert.rejects(
    api("GET", "/issues"),
    (error) => error.status === 403 && !error.message.includes("secret"),
  );
  assert.equal(options.redirect, "error");
  for (const path of ["/../other/repo/issues", "/%2e%2e/other/repo/issues", "/\\evil.invalid"]) {
    await assert.rejects(api("GET", path), /Invalid incident API path/);
  }
});

test("quality log redirect validation refuses untrusted destinations before download", async () => {
  for (const location of [
    "https://logs.example.org/log",
    "https://blob.core.windows.net.evil.invalid/log",
    "http://logs.blob.core.windows.net/log",
    "https://user:password@logs.blob.core.windows.net/log",
  ]) {
    let calls = 0;
    await assert.rejects(
      jobMeasurements("fixture-token", 1, async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      }),
      /redirect host refused/,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    jobMeasurements("fixture-token", 1, async () => new Response("untrusted", { status: 200 })),
    /redirect unavailable/,
  );
});

test("signed log download has no token and refuses further redirects", async () => {
  for (const host of ["logs.blob.core.windows.net", "logs.actions.githubusercontent.com"]) {
    const calls = [];
    const metrics = await jobMeasurements("fixture-token", 1, async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: `https://${host}/log` } })
        : new Response("server-response-time maxNumericValue\nexpected: <=600\nfound: 660\n");
    });
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).hostname, "api.github.com");
    assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-token");
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(calls[1].options.redirect, "error");
    assert.deepEqual(metrics, ["server-response-time: threshold <=600; measured 660"]);
  }
});

test("API and log response caps reject oversized bodies", async () => {
  const oversized = (limit) => new Response(new Uint8Array(limit + 1));
  await assert.rejects(
    githubApi("fixture-token", async () => oversized(2 * 1024 * 1024))("GET", "/issues"),
    /exceeded response size cap/,
  );
  let calls = 0;
  await assert.rejects(
    jobMeasurements("fixture-token", 1, async () => {
      calls++;
      return calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://logs.blob.core.windows.net/log" },
          })
        : oversized(8 * 1024 * 1024);
    }),
    /exceeded response size cap/,
  );
});
