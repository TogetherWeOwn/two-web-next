// Every socket is loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { cycle, diff, parseArgs, summarize } from "./shadow-compare.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}
const page = (origin, title) =>
  `<title>${title}</title><link rel="canonical" href="${origin}/"><h1>Hi</h1>`.padEnd(200, " ");

test("parseArgs rejects unsafe targets and paths", () => {
  assert.throws(() => parseArgs(["--legacy", "http://togetherweown.com"]), /https/);
  assert.throws(() => parseArgs(["--next", "https://u:p@next.togetherweown.com"]), /bare origin/);
  assert.throws(() => parseArgs(["--next", "https://togetherweown.com"]), /differ/);
  assert.throws(() => parseArgs(["--paths", "//evil.example/x"]), /bad path/);
  assert.throws(() => parseArgs(["--interval-s", "1"]), /interval/);
  assert.equal(parseArgs([]).next, "https://next.togetherweown.com");
});

test("identical pages modulo origin match; drift is reported field by field", async () => {
  let titleB = "Same";
  const hold = { a: null, b: null };
  const handler = (side, title) => (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/" ? page(hold[side].origin, title()) : "x");
  };
  hold.a = await serve(handler("a", () => "Same"));
  hold.b = await serve(handler("b", () => titleB));
  try {
    const options = { legacy: hold.a.origin, next: hold.b.origin, paths: ["/"], timeoutMs: 2000 };
    const same = await cycle(options);
    assert.equal(same.results[0].ok, true, JSON.stringify(same.results[0].diffs));
    titleB = "Different";
    const drift = await cycle(options);
    assert.equal(drift.results[0].ok, false);
    assert.deepEqual(
      drift.results[0].diffs.map((d) => d.field),
      ["title"],
    );
  } finally {
    hold.a.server.close();
    hold.b.server.close();
  }
});

test("transport failure counts as a mismatch, never as success", async () => {
  const a = await serve((_req, res) => res.end());
  const origin = a.origin;
  a.server.close();
  const rec = await cycle({
    legacy: origin,
    next: origin.replace("127.0.0.1", "localhost"),
    paths: ["/"],
    timeoutMs: 500,
  });
  assert.equal(rec.results[0].ok, false);
  assert.equal(rec.results[0].diffs[0].field, "transport");
});

test("cache-control alone is informational; large body spread is not", () => {
  const base = {
    status: 200,
    contentType: "text/html",
    location: null,
    title: "t",
    h1: null,
    canonical: null,
    bodyBytes: 100,
  };
  assert.equal(
    diff({ ...base, cacheControl: "a" }, { ...base, cacheControl: "b" }).every(
      (d) => d.informational,
    ),
    true,
  );
  assert.equal(
    diff({ ...base, cacheControl: null }, { ...base, cacheControl: null, bodyBytes: 10 })[0].field,
    "bodyBytes",
  );
});

test("summarize counts mismatches per path and reports percentiles", () => {
  const rec = (ts, ok) => ({
    ts,
    results: [
      {
        path: "/",
        legacyMs: 10,
        nextMs: 20,
        ok,
        diffs: ok ? [] : [{ field: "status", legacy: 200, next: 404 }],
      },
    ],
  });
  const s = summarize([rec("2026-10-07T00:00:00Z", true), rec("2026-10-10T00:00:00Z", false)]);
  assert.equal(s.hours, 72);
  assert.equal(s.clean, false);
  assert.deepEqual(s.paths[0].fields, { status: 1 });
  assert.equal(s.paths[0].nextP95, 20);
});
