import { expect, test } from "./fixtures";

test("serves the existing data font with a cacheable fixture response", async ({ context }) => {
  const response = await context.request.get("/fonts/fragment-mono-latin-400.woff2");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await response.body()).byteLength).toBeGreaterThan(0);
});
