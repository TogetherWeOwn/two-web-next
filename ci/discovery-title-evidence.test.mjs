import assert from "node:assert/strict";
import { test } from "node:test";
import { afterSha, digest, states, validate, viewports } from "./discovery-title-evidence.mjs";

const provenance = {
  before: "a".repeat(40),
  after: afterSha,
  runUrl: "https://example.test/run/1",
};
function fixture() {
  const rows = [];
  const images = new Map();
  for (const identity of ["before", "after"])
    for (const renderer of ["hono", "kit"])
      for (const [stateId, [path, title]] of Object.entries(states))
        for (const [name, size] of Object.entries(viewports)) {
          const png = `${identity}/${identity}-${renderer}-${stateId}-${name}.png`;
          const bytes = Buffer.alloc(24);
          bytes.write("89504e470d0a1a0a", "hex");
          bytes.writeUInt32BE(size.width, 16);
          bytes.writeUInt32BE(size.height, 20);
          images.set(png, bytes);
          const origin =
            stateId === "S5" || stateId === "S6"
              ? "https://period.example.test"
              : renderer === "hono"
                ? "https://localhost:8787"
                : "http://127.0.0.1:8788";
          const documentTitle = `${title} — Together We Own`;
          rows.push({
            identity,
            renderer,
            stateId,
            sha: provenance[identity],
            runUrl: provenance.runUrl,
            viewport: `${size.width}x${size.height}`,
            url: `${origin}${path}`,
            documentTitle,
            previousTitle: documentTitle,
            h1: "Events",
            interaction: "none",
            capturedAt: "2026-04-01T00:00:00Z",
            httpStatus: ["S7", "S8"].includes(stateId) ? 422 : 200,
            png,
            pngSha256: digest(bytes),
          });
        }
  return { rows, load: (png) => images.get(png) };
}
test("accepts exactly the complete matrix", () => {
  const { rows, load } = fixture();
  validate(rows, provenance, load);
});
for (const [field, value] of Object.entries({
  sha: "bad",
  viewport: "360x780",
  pngSha256: "bad",
  url: "https://example.test/",
  httpStatus: 422,
  documentTitle: "Wrong",
  h1: "",
  previousTitle: "Wrong",
}))
  test(`rejects invalid ${field}`, () => {
    const { rows, load } = fixture();
    const target = rows.find((r) => r.identity === "after" && r.stateId === "I5");
    target[field] = value;
    assert.throws(() => validate(rows, provenance, load));
  });
for (const duplicate of [false, true])
  test(`rejects ${duplicate ? "duplicate" : "missing"} cells`, () => {
    const { rows, load } = fixture();
    if (duplicate) rows[0] = rows[1];
    else rows.pop();
    assert.throws(() => validate(rows, provenance, load));
  });
