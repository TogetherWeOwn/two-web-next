// Selftest-only entry point: identical CLI policy as deps-audit.mjs with a
// millisecond backoff so retry-exhaustion cases stay fast. The production
// entry ci/deps-audit.mjs keeps its fixed 5s/15s schedule, accepts no argv,
// and reads no environment variable that shortens retries, so nothing an
// untrusted caller controls can select this pacing; only an explicit
// invocation of this file does. It must sit next to deps-audit.mjs (which
// resolves the registry guard and allowlist relative to its own URL).
import { runAudit } from "./deps-audit.mjs";

try {
  runAudit({ retryDelaysMs: [50, 150] });
} catch (error) {
  console.error(
    `Dependency audit failed: ${error instanceof SyntaxError ? "Invalid JSON" : error.message}`,
  );
  process.exitCode = 1;
}
