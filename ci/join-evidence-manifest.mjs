import { createHash } from "node:crypto";
import {
  expectedCaptureNames,
  validateCaptureFiles,
  validateCaptureTap,
  validateSourceIdentities,
} from "./join-evidence-contract.mjs";
import { validateCapturePng } from "./join-evidence-png.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The caller reads each admitted file once; the hashes describe the validated bytes.
export function createCaptureManifest({ entries, files, actual, expected, runId, runAttempt }) {
  validateSourceIdentities(actual, expected);
  validateCaptureFiles(entries);
  if (!runId || !runAttempt) throw new Error("Actions run identity is required");
  const tap = files.get("test-report.tap");
  if (!Buffer.isBuffer(tap)) throw new Error("TAP report bytes are required");
  validateCaptureTap(tap.toString("utf8"));
  const images = expectedCaptureNames().map((file) => {
    const [, renderer, state, size] = /^(hono|kit)-(.+)-(1280|390)\.png$/.exec(file);
    const width = Number(size);
    const height = width === 390 ? 844 : 800;
    const bytes = files.get(file);
    const dimensions = validateCapturePng(bytes, width, height);
    return {
      file,
      sha256: sha256(bytes),
      renderer,
      state,
      viewport: { width, height },
      dimensions,
    };
  });
  return {
    applicationSha: actual.application,
    controllerSha: actual.controller,
    runId,
    runAttempt,
    reportSha256: sha256(tap),
    limitations:
      "Fixture loads and hooks do not verify authentication, real route loading, or production.",
    images,
  };
}
