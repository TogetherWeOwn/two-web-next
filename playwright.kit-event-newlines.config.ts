import { defineConfig } from "@playwright/test";
import parity from "./playwright.kit-parity.config";

const kit = Array.isArray(parity.webServer)
  ? parity.webServer.find((server) => server.command === "node ci/kit-worker-dev.mjs")
  : undefined;
if (!kit) throw new Error("The loopback Kit Worker fixture is required");
if (!["before", "after"].includes(process.env.KIT_EVENT_NEWLINE_PHASE ?? "")) {
  throw new Error("Expected the before or after Kit event newline evidence phase");
}

export default defineConfig({
  ...parity,
  // The regular parity fixture does not enable the Kit edit GET.
  testMatch: "admin-event-newlines.capture.ts",
  outputDir: "artifacts/kit-event-newlines/images",
  reporter: [["list"], ["json", { outputFile: "artifacts/kit-event-newlines/results.json" }]],
  use: { ...parity.use, trace: "off", screenshot: "off", video: "off" },
  timeout: 60_000,
  webServer: { ...kit, env: { WRANGLER_SEND_METRICS: "false" } },
});
