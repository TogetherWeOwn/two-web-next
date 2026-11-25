import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";

it("acknowledges an oversized CSP report without Hono or reading the upload", async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/csp-reports/+server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "csp-retirement-fixture",
        setup(build) {
          build.onResolve({ filter: /^hono(?:\/|$)/ }, () => ({
            errors: [{ text: "The Kit CSP endpoint must run without Hono" }],
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "csp-fixture",
          }));
          build.onLoad({ filter: /^workers$/, namespace: "csp-fixture" }, () => ({
            contents: "export const env = { CSP_REPORT_SAMPLE_RATE: '0' };",
          }));
        },
      },
    ],
  });
  const [bundle] = outputFiles;
  assert.ok(bundle, "missing CSP endpoint bundle");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.contents).toString("base64")}`;
  const { POST } = await import(moduleUrl);
  const pull = vi.fn((controller: ReadableStreamDefaultController) => controller.close());
  const request = new Request("https://kit.example.test/csp-reports?fixture=oversize", {
    method: "POST",
    headers: {
      "content-length": "8193",
      "content-type": "application/csp-report",
      origin: "https://reporter.example.test",
    },
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
  } as RequestInit);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await POST({ request });
    expect(response.status).toBe(204);
    expect([...response.headers]).toEqual([["cache-control", "no-store"]]);
    expect(response.body).toBeNull();
    expect(request.bodyUsed).toBe(false);
    expect(pull).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["csp.report.dropped_oversize", { bytes: 8193 }]]);
  } finally {
    warn.mockRestore();
  }
});
