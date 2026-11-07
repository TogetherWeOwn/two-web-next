// Route-parity tooling selftests: no Worker, no database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compareRecordings, diffResponse, parseExceptions, report } from "./compare.mjs";
import {
  ASSET_ETAG_MASK,
  clientAddress,
  describeBody,
  jsonShape,
  MASK,
  maskAssetEtag,
  normalizeHeaders,
  normalizeSetCookie,
} from "./normalize.mjs";
import { goldenJson } from "./record.mjs";
import { signedCookieNames } from "./signed-cookies.mjs";
import { buildVectors, concretePath, listPublicFiles, slug } from "./vectors.mjs";

const repo = join(import.meta.dirname, "../..");
const inventory = JSON.parse(
  readFileSync(join(repo, "test/fixtures/route-inventory.json"), "utf8"),
);
const publicFiles = listPublicFiles(join(repo, "public"));
const matrix = buildVectors({
  inventory,
  publicFiles,
  kitPaths: ["/", "/hotzones/voice", "/members/:user"],
  throttles: [{ method: "POST", path: "/logout", limit: 30 }],
});
const ids = (file) => matrix.vectors.filter((v) => v.file === file).map((v) => v.id);

test("every inventory entry, public file and Kit path maps to a recorded vector", () => {
  const keys = new Set(matrix.vectors.map((v) => `${v.file}#${v.id}`));
  for (const entry of inventory) {
    const row = matrix.coverage.find((c) => c.entry === `${entry.method} ${entry.path}`);
    assert.ok(row, `${entry.method} ${entry.path} is covered`);
    assert.ok(keys.has(`${row.file}#${row.vector}`), `${row.file}#${row.vector} exists`);
  }
  for (const path of publicFiles)
    assert.ok(matrix.coverage.some((c) => c.entry === `STATIC GET ${path}`));
  assert.ok(
    matrix.coverage.some(
      (c) => c.entry === "KIT GET /hotzones/voice" && c.file === "kit/hotzones_voice",
    ),
  );
  assert.ok(
    matrix.coverage.some(
      (c) => c.entry === "KIT GET /members/:user" && c.file === "routes/members_user",
    ),
  );
});

test("the matrix carries the method, path, conditional and negotiation vectors", () => {
  const about = ids("routes/about");
  for (const id of [
    "GET",
    "HEAD",
    "OPTIONS",
    "DELETE",
    "GET path:trailing-slash",
    "GET path:__data.json",
    "GET path:encoded-slash",
    "GET path:encoded-percent",
    "GET if-none-match:exact",
    "GET if-none-match:weak",
    "GET if-none-match:star",
    "GET identity:expired",
  ]) {
    assert.ok(about.includes(id), `routes/about has ${id}`);
  }
  assert.ok(ids("routes/e_file..md").includes("GET path:multi-segment"));
  assert.equal(
    matrix.vectors.find((v) => v.file === "routes/e_file..md" && v.id === "GET path:multi-segment")
      .path,
    "/e/a/b.md",
  );
  assert.equal(
    matrix.vectors.find(
      (v) => v.file === "routes/events_file..ics" && v.id === "GET path:multi-segment",
    ).path,
    "/events/a/b.ics",
  );
  const rsvp = [...ids("routes/e_key_rsvp"), ...ids("routes/events_key_rsvp")];
  for (const id of [
    "POST accept:html",
    "POST accept:json",
    "POST origin:cross",
    "POST origin:missing",
    "POST content-type:text",
    "POST body:oversized",
    "PUT identity:member",
  ]) {
    assert.ok(rsvp.includes(id), `rsvp has ${id}`);
  }
  assert.ok(ids("routes/admin_ops-overrides").includes("POST bearer:wrong"));
  assert.ok(ids("routes/auth_qa_identity").includes("POST qa-token:wrong"));
  const burst = matrix.vectors.find((v) => v.id === "POST throttle:exhausted");
  assert.equal(burst.repeat, 31);
  assert.equal(burst.file, "routes/logout");
});

test("path helpers are concrete and collision-free", () => {
  assert.equal(concretePath("/events/:key/rsvp"), "/events/01J00000000000000000000001/rsvp");
  assert.equal(concretePath("/admin/*"), "/admin/parity-unregistered");
  assert.equal(slug("/"), "root");
  assert.notEqual(slug("/members/"), slug("/members/*"));
  assert.equal(slug("/.well-known/security.txt"), "_well-known_security.txt");
  assert.throws(() => concretePath("/x/:unknown"), /No parity value/);
  assert.throws(
    () =>
      buildVectors({
        inventory: [
          { method: "GET", path: "/a b", auth: "public" },
          { method: "GET", path: "/a_b", auth: "public" },
        ],
        publicFiles: [],
        kitPaths: [],
        throttles: [],
      }),
    /collision/,
  );
});

test("headers keep the contract and mask per-request values", () => {
  const out = normalizeHeaders([
    "Date",
    "Thu, 01 Jan 2099 00:00:00 GMT",
    "X-Request-Id",
    "abc",
    "Content-Security-Policy",
    "script-src 'self' 'nonce-r4nd0m'",
    "Set-Cookie",
    "__Host-two_session=secret.sig; Path=/; HttpOnly; Secure; SameSite=Lax",
    "Set-Cookie",
    "__Host-two_oauth_state=; Max-Age=0; Path=/",
    "Retry-After",
    "37",
    "Vary",
    "Cookie",
    "x-parity-route",
    "/events/:key",
    "x-parity-alerts",
    "[]",
    "x-parity-outbound",
    '["GET https://discord.com/api"]',
  ]);
  assert.deepEqual(out.headers, {
    "content-security-policy": `script-src 'self' 'nonce-${MASK}'`,
    date: MASK,
    "retry-after": "<seconds>",
    vary: "Cookie",
    "x-request-id": MASK,
  });
  assert.deepEqual(out.setCookies[0], {
    name: "__Host-two_session",
    value: MASK,
    attributes: ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"],
  });
  assert.equal(out.setCookies[1].value, "", "a deletion stays visible");
  assert.equal(out.route, "/events/:key");
  assert.deepEqual(out.outbound, ["GET https://discord.com/api"]);
  assert.deepEqual(normalizeSetCookie("flag").name, "flag");
});

test("dev asset ETags are masked; the app's sha256 ETags are kept", () => {
  const etag = (value) => normalizeHeaders(["ETag", value]).headers.etag;
  assert.equal(etag('"5b20db3024084b7736ae40940ade9026"'), `"${ASSET_ETAG_MASK}"`);
  assert.equal(etag('W/"5b20db3024084b7736ae40940ade9026"'), `W/"${ASSET_ETAG_MASK}"`);
  const app = `"${"a".repeat(64)}"`;
  assert.equal(etag(app), app);
  assert.equal(maskAssetEtag('W/"5b20db3024084b7736ae40940ade9026"'), `W/"${ASSET_ETAG_MASK}"`);
  assert.equal(maskAssetEtag("*"), "*");
});

test("bodies hash after masking nonces and the request id; JSON keeps a shape", () => {
  const a = describeBody(
    Buffer.from('<script nonce="aaa">x</script> id 0011'),
    "text/html; charset=utf-8",
    "0011",
  );
  const b = describeBody(
    Buffer.from('<script nonce="bbb">x</script> id 0022'),
    "text/html",
    "0022",
  );
  assert.equal(a.sha256, b.sha256);
  const json = describeBody(Buffer.from('{"b":[1,2],"a":{"c":null}}'), "application/json", "x");
  assert.deepEqual(json.shape, { a: { c: "null" }, b: ["number"] });
  assert.deepEqual(jsonShape([1, "x"]), [{ oneOf: ["number", "string"] }]);
  assert.equal(describeBody(Buffer.alloc(0), "text/html", "x").kind, "empty");
  assert.equal(describeBody(Buffer.from([0, 1]), "font/woff2", "x").kind, "binary");
  assert.equal(describeBody(Buffer.from("{"), "application/json", "x").kind, "json-invalid");
  assert.match(clientAddress("routes/about#GET"), /^10\.\d+\.\d+\.\d+$/);
});

const response = (overrides = {}) => ({
  status: 200,
  headers: { "content-type": "text/html" },
  setCookies: [],
  body: { kind: "text", bytes: 1, sha256: "a" },
  route: "/about",
  tailLabel: "/about",
  alerts: [],
  outbound: [],
  ...overrides,
});
const recording = (vectors) => new Map([["routes/about", vectors]]);

test("compare reports every field difference and honours approved exceptions", () => {
  assert.deepEqual(diffResponse(response(), response()), []);
  const diffs = diffResponse(
    response(),
    response({ status: 308, headers: { location: "/about" } }),
  );
  assert.deepEqual(
    diffs.map((d) => d.field),
    ["status", "headers.content-type", "headers.location"],
  );
  const base = recording({ GET: { response: response() }, HEAD: { response: response() } });
  const cand = recording({ GET: { response: response({ status: 308 }) } });
  const result = compareRecordings(base, cand, [
    { vector: "routes/about#G*", field: "status", reason: "trailing-slash policy" },
    { vector: "routes/none#GET", field: "*", reason: "stale" },
  ]);
  assert.deepEqual(
    result.failures.map((f) => `${f.key} ${f.field}`),
    ["routes/about#HEAD missing"],
  );
  assert.equal(result.approved.length, 1);
  assert.equal(result.unused.length, 1);
  assert.match(report(result, "selftest"), /1 difference\(s\), 1 approved/);
});

test("the exceptions table in docs/kit-parity-gates.md parses and starts empty", () => {
  const doc = readFileSync(join(repo, "docs/kit-parity-gates.md"), "utf8");
  assert.deepEqual(parseExceptions(doc), []);
  assert.throws(() => parseExceptions("no markers"), /markers/);
  const row =
    "<!-- route-parity-exceptions:start -->\n| `a#GET` | `status` | |\n<!-- route-parity-exceptions:end -->";
  assert.throws(() => parseExceptions(row), /no reason/);
});

test("signed-cookie vectors cover every cookie the card names", () => {
  const names = [...signedCookieNames(repo).keys()];
  for (const name of [
    "__Host-two_session",
    "__Host-two_oauth_state",
    "__Host-two_join_source",
    "__Host-two_join_next",
    "__Host-two_session_status",
    "__Host-two_login_next",
  ]) {
    assert.ok(names.includes(name), `${name} is signed in src/`);
  }
  const committed = JSON.parse(
    readFileSync(join(repo, "test/fixtures/parity/signed-cookies.json"), "utf8"),
  );
  assert.deepEqual(
    committed.cookies.map((c) => c.name),
    names,
  );
});

test("goldens are written one vector per line and round-trip", () => {
  const vectors = { GET: { response: { status: 200 } }, HEAD: { response: { status: 200 } } };
  const text = goldenJson({ file: "routes/about" }, "vectors", vectors);
  assert.deepEqual(JSON.parse(text), { file: "routes/about", vectors });
  assert.equal(text.trimEnd().split("\n").length, 7);
  const coverage = [{ entry: "GET /", file: "routes/root", vector: "GET" }];
  assert.deepEqual(JSON.parse(goldenJson({ schema: 1 }, "coverage", coverage)), {
    schema: 1,
    coverage,
  });
});
