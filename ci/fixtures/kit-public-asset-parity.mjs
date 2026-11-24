import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publicAssets = [
  ["/styles.css", "text/css; charset=utf-8", "public, max-age=0, must-revalidate"],
  ["/fonts/fragment-mono-latin-400.woff2", "font/woff2", "public, max-age=31536000, immutable"],
];

// Both Workers serve these public files through the real ASSETS binding.
// Pin the contract for each Worker so a regression shared by both still fails.
export async function assertPublicAssetParity({ honoOrigin, kitOrigin }) {
  const targets = [
    ["Hono", honoOrigin],
    ["built Kit", kitOrigin],
  ];
  const request = (origin, path) =>
    fetch(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(5_000) });

  for (const [path, contentType, cacheControl] of publicAssets) {
    const expected = await readFile(new URL(`../../public${path}`, import.meta.url));
    assert.ok(expected.length > 0, `${path}: public source file is nonempty`);
    for (const [name, origin] of targets) {
      const label = `${name} GET ${path}`;
      const response = await request(origin, path);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, `${label}: status`);
      assert.equal(response.headers.get("content-type"), contentType, `${label}: content type`);
      assert.equal(response.headers.get("cache-control"), cacheControl, `${label}: cache policy`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
      assert.ok(body.equals(expected), `${label}: body matches the public source file`);
    }
  }

  const missingPath = "/fonts/fixture-missing-public-asset.woff2";
  for (const [name, origin] of targets) {
    const label = `${name} GET ${missingPath}`;
    const response = await request(origin, missingPath);
    const body = await response.text();
    assert.equal(response.status, 404, `${label}: status`);
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=UTF-8",
      `${label}: content type`,
    );
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, private",
      `${label}: cache policy`,
    );
    assert.equal(response.headers.get("etag"), null, `${label}: no asset validator`);
    assert.match(body, /We cannot find that page/, `${label}: branded 404`);
  }
}
