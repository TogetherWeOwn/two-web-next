import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyKitMultipartModules } from "./kit-multipart-modules.mjs";

const BOUNDARY = "kitBoundary-0123456789";
const SECRET = "SENTINEL-value-do-not-leak";
const CRLF = "\r\n";
const META_HEADER = 'Content-Disposition: form-data; name="metadata"';
const WORKER_HEADERS = [
  'Content-Disposition: form-data; name="worker.js"; filename="worker.js"',
  "Content-Type: application/javascript+module",
];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const text = (s) => Buffer.from(s, "utf8");

// Contains bytes resembling, but never equal to, the real delimiter.
const WORKER = Buffer.concat([
  Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]),
  text(`${CRLF}--${BOUNDARY}x${CRLF}--${BOUNDARY.slice(0, 5)}--${CRLF}-`),
  text("export default { fetch() { return new Response('ok'); } };"),
  Buffer.from([0xc3, 0x28, 0x00]),
]);

function metaJson(overrides = {}) {
  return JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-01-01",
    bindings: [
      { name: "ZED_VAR", type: "plain_text", text: SECRET },
      { name: "APP_QUEUE", type: "queue", queue_name: SECRET },
      { name: "DB", type: "hyperdrive", id: SECRET },
    ],
    ...overrides,
  });
}

function build({
  boundary = BOUNDARY,
  meta = metaJson(),
  worker = WORKER,
  preamble = "",
  metaHeader = META_HEADER,
  workerHeaders = WORKER_HEADERS,
  extraParts = [],
  ending = `--${boundary}--${CRLF}`,
} = {}) {
  const metaBuf = Buffer.isBuffer(meta) ? meta : text(meta);
  const chunks = [
    text(preamble),
    text(`--${boundary}${CRLF}${metaHeader}${CRLF}${CRLF}`),
    metaBuf,
    text(`${CRLF}--${boundary}${CRLF}${workerHeaders.join(CRLF)}${CRLF}${CRLF}`),
    worker,
  ];
  for (const part of extraParts) chunks.push(text(`${CRLF}--${boundary}${CRLF}${part}`));
  chunks.push(text(`${CRLF}${ending}`));
  return Buffer.concat(chunks);
}

function assertRejects(body, expected = WORKER) {
  assert.throws(
    () => verifyKitMultipartModules(body, expected),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length > 0);
      assert.ok(!error.message.includes(SECRET));
      assert.ok(!error.message.includes("ZED_VAR"));
      assert.ok(!error.message.includes(BOUNDARY));
      return true;
    },
  );
}

test("accepts the exact two-part envelope and returns a sanitized projection", () => {
  const result = verifyKitMultipartModules(build(), WORKER);
  assert.deepEqual(result, {
    schema: "two.kit-multipart-modules.v1",
    evidence: "dry-run-module-envelope-only",
    worker: {
      name: "worker.js",
      mime: "application/javascript+module",
      bytes: WORKER.length,
      sha256: sha256(WORKER),
    },
    metadata: {
      bytes: text(metaJson()).length,
      sha256: sha256(text(metaJson())),
      bindings: [
        { name: "APP_QUEUE", type: "queue" },
        { name: "DB", type: "hyperdrive" },
        { name: "ZED_VAR", type: "plain_text" },
      ],
    },
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes("compatibility_date"));
});

test("accepts a missing final CRLF and all allowed binding types", () => {
  const types = ["plain_text", "hyperdrive", "queue", "assets", "version_metadata", "inherit"];
  const meta = metaJson({ bindings: types.map((type, i) => ({ name: `B${i}`, type })) });
  const result = verifyKitMultipartModules(build({ meta, ending: `--${BOUNDARY}--` }), WORKER);
  assert.deepEqual(
    result.metadata.bindings.map((b) => b.type),
    types,
  );
});

test("accepts an empty bindings array and boundary length limits", () => {
  const meta = metaJson({ bindings: [] });
  assert.deepEqual(verifyKitMultipartModules(build({ meta }), WORKER).metadata.bindings, []);
  for (const boundary of ["a", "a".repeat(70)]) {
    assert.equal(
      verifyKitMultipartModules(build({ boundary }), WORKER).worker.sha256,
      sha256(WORKER),
    );
  }
});

test("rejects non-Buffer inputs", () => {
  assert.throws(() => verifyKitMultipartModules("text", WORKER));
  assert.throws(() => verifyKitMultipartModules(build(), "text"));
  assert.throws(() => verifyKitMultipartModules(new Uint8Array(build()), WORKER));
});

test("rejects invalid boundaries", () => {
  for (const boundary of ["", "a".repeat(71), "bad_boundary", "bad boundary"]) {
    assertRejects(build({ boundary }));
  }
});

test("rejects an extra module, source map or third part", () => {
  const extra = (name, ct) =>
    `Content-Disposition: form-data; name="${name}"; filename="${name}"${CRLF}` +
    `Content-Type: ${ct}${CRLF}${CRLF}export {};`;
  assertRejects(build({ extraParts: [extra("extra.js", "application/javascript+module")] }));
  assertRejects(build({ extraParts: [extra("worker.js.map", "application/source-map")] }));
});

test("rejects duplicate metadata and a missing part", () => {
  const body = build({
    extraParts: [`${META_HEADER}${CRLF}${CRLF}${metaJson()}`],
  });
  assertRejects(body);
  const metaOnly = text(
    `--${BOUNDARY}${CRLF}${META_HEADER}${CRLF}${CRLF}${metaJson()}${CRLF}--${BOUNDARY}--${CRLF}`,
  );
  assertRejects(metaOnly);
  const workerOnly = Buffer.concat([
    text(`--${BOUNDARY}${CRLF}${WORKER_HEADERS.join(CRLF)}${CRLF}${CRLF}`),
    WORKER,
    text(`${CRLF}--${BOUNDARY}--${CRLF}`),
  ]);
  assertRejects(workerOnly);
});

test("rejects wrong MIME, part name, filename and header form", () => {
  assertRejects(
    build({ workerHeaders: [WORKER_HEADERS[0], "Content-Type: application/javascript"] }),
  );
  assertRejects(build({ workerHeaders: [WORKER_HEADERS[0], "Content-Type: application/wasm"] }));
  assertRejects(
    build({
      workerHeaders: [
        'Content-Disposition: form-data; name="other.js"; filename="worker.js"',
        WORKER_HEADERS[1],
      ],
    }),
  );
  assertRejects(
    build({
      workerHeaders: [
        'Content-Disposition: form-data; name="worker.js"; filename="other.js"',
        WORKER_HEADERS[1],
      ],
    }),
  );
  assertRejects(build({ metaHeader: 'Content-Disposition: form-data; name="meta"' }));
  assertRejects(
    build({
      metaHeader: `${META_HEADER}${CRLF}Content-Type: application/json`,
    }),
  );
  assertRejects(build({ workerHeaders: [WORKER_HEADERS[1], WORKER_HEADERS[0]] }));
});

test("rejects preamble and epilogue", () => {
  assertRejects(build({ preamble: `preamble${CRLF}` }));
  assertRejects(build({ preamble: CRLF }));
  assertRejects(build({ ending: `--${BOUNDARY}--${CRLF}epilogue` }));
  assertRejects(build({ ending: `--${BOUNDARY}--${CRLF}${CRLF}` }));
  assertRejects(build({ ending: `--${BOUNDARY}--  ${CRLF}` }));
});

test("rejects malformed endings", () => {
  assertRejects(build({ ending: `--${BOUNDARY}` }));
  assertRejects(build({ ending: `--${BOUNDARY}-${CRLF}` }));
  assertRejects(build({ ending: `--${BOUNDARY}--\n` }));
  assertRejects(build({ ending: `--${BOUNDARY}x--${CRLF}` }));
  assertRejects(build().subarray(0, 40));
  assertRejects(Buffer.alloc(0));
});

test("rejects an interior closing delimiter even when Worker bytes match", () => {
  const worker = text(`export {};${CRLF}--${BOUNDARY}--${CRLF}trailing bytes`);
  assertRejects(build({ worker }), worker);
});

test("rejects LF-only framing", () => {
  const textWorker = text("export default {};");
  const crlfBody = build({ worker: textWorker });
  const lfBody = Buffer.from(crlfBody.toString("latin1").replaceAll(CRLF, "\n"), "latin1");
  assert.doesNotThrow(() => verifyKitMultipartModules(crlfBody, textWorker));
  assertRejects(lfBody, textWorker);
});

test("rejects invalid UTF-8, invalid JSON and non-object metadata", () => {
  assertRejects(build({ meta: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]) }));
  assertRejects(build({ meta: `{"main_module": "worker.js", "bindings": [` }));
  assertRejects(build({ meta: "[]" }));
  assertRejects(build({ meta: "null" }));
  assertRejects(build({ meta: '"worker.js"' }));
  assertRejects(build({ meta: "" }));
});

test("rejects a missing or wrong main_module", () => {
  const missing = JSON.parse(metaJson());
  delete missing.main_module;
  assertRejects(build({ meta: JSON.stringify(missing) }));
  assertRejects(build({ meta: metaJson({ main_module: "other.js" }) }));
  assertRejects(build({ meta: metaJson({ main_module: ["worker.js"] }) }));
  assertRejects(build({ meta: metaJson({ main_module: "Worker.js" }) }));
});

test("rejects bad bindings arrays, names and types", () => {
  const withBindings = (bindings) => build({ meta: metaJson({ bindings }) });
  const missing = JSON.parse(metaJson());
  delete missing.bindings;
  assertRejects(build({ meta: JSON.stringify(missing) }));
  assertRejects(withBindings({}));
  assertRejects(withBindings(["DB"]));
  assertRejects(
    withBindings([
      { name: "DB", type: "queue" },
      { name: "DB", type: "queue" },
    ]),
  );
  assertRejects(withBindings([{ name: "lower", type: "queue" }]));
  assertRejects(withBindings([{ name: "1ABC", type: "queue" }]));
  assertRejects(withBindings([{ name: "A".repeat(129), type: "queue" }]));
  assertRejects(withBindings([{ name: "", type: "queue" }]));
  assertRejects(withBindings([{ name: "DB", type: "kv_namespace" }]));
  assertRejects(withBindings([{ name: "DB" }]));
  assertRejects(withBindings([{ name: 7, type: "queue" }]));
  const many = Array.from({ length: 129 }, (_, i) => ({ name: `B${i}`, type: "inherit" }));
  assertRejects(withBindings(many));
});

test("accepts exactly 128 bindings and a 128 character name", () => {
  const many = Array.from({ length: 128 }, (_, i) => ({ name: `B${i}`, type: "inherit" }));
  assert.equal(
    verifyKitMultipartModules(build({ meta: metaJson({ bindings: many }) }), WORKER).metadata
      .bindings.length,
    128,
  );
  const long = [{ name: "A".repeat(128), type: "queue" }];
  assert.equal(
    verifyKitMultipartModules(build({ meta: metaJson({ bindings: long }) }), WORKER).metadata
      .bindings[0].name.length,
    128,
  );
});

test("rejects secret_text bindings without echoing their values", () => {
  const body = build({
    meta: metaJson({
      bindings: [{ name: "TOKEN", type: "secret_text", text: SECRET }],
    }),
  });
  assertRejects(body);
});

test("rejects oversize metadata", () => {
  const big = metaJson({ padding: "x".repeat(256 * 1024) });
  assert.ok(text(big).length > 256 * 1024);
  assertRejects(build({ meta: big }));
});

test("rejects an empty worker", () => {
  assertRejects(build({ worker: Buffer.alloc(0) }), Buffer.alloc(0));
  assertRejects(build({ worker: Buffer.alloc(0) }));
});

test("rejects a worker that differs from the expected bytes", () => {
  const changed = Buffer.from(WORKER);
  changed[changed.length - 1] ^= 0x01;
  assertRejects(build({ worker: changed }));
  assertRejects(build(), changed);
  assertRejects(build(), WORKER.subarray(0, WORKER.length - 1));
  assertRejects(build(), Buffer.concat([WORKER, Buffer.from([0])]));
});
