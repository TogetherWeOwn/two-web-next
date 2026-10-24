// Test-only CLI preload. The marker path is inert data, never executable source.
import { appendFileSync } from "node:fs";

globalThis.fetch = () => {
  appendFileSync(process.env.AUTH_PERF_FETCH_MARKER, "called\n");
  throw new Error("fixture refuses all network");
};
