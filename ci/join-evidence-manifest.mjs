import { createHash } from "node:crypto";
import {
  expectedCaptureNames,
  validateCaptureFiles,
  validateCaptureTap,
  validateSourceIdentities,
} from "./join-evidence-contract.mjs";
import { readCaptureFiles } from "./join-evidence-files.mjs";
import { validateCapturePng } from "./join-evidence-png.mjs";
import { collectSourceIdentities } from "./join-evidence-source.mjs";

const targetController = "94e2a41941e5c0779120ce997dbbd815e9bb0874";

// The capture runner must collect both identities from its checked-out worktrees.
export async function createTargetCaptureManifest({
  directory,
  actual,
  expected,
  runId,
  runAttempt,
}) {
  validateSourceIdentities(actual, expected);
  if (actual.controller !== targetController) throw new Error("unsupported target controller SHA");
  const evidence = await readCaptureFiles(directory, "target");
  return createCaptureManifest({
    ...evidence,
    actual,
    expected,
    runId,
    runAttempt,
    profile: "target",
  });
}

export async function createTargetManifestFromCheckouts({
  applicationRoot,
  controllerRoot,
  ...options
}) {
  const actual = collectSourceIdentities(applicationRoot, controllerRoot);
  return createTargetCaptureManifest({ ...options, actual });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The caller reads each admitted file once; the hashes describe the validated bytes.
export function createCaptureManifest({
  entries,
  files,
  actual,
  expected,
  runId,
  runAttempt,
  profile = "baseline",
}) {
  validateSourceIdentities(actual, expected);
  validateCaptureFiles(entries, profile);
  if (!runId || !runAttempt) throw new Error("Actions run identity is required");
  const tap = files.get("test-report.tap");
  if (!Buffer.isBuffer(tap)) throw new Error("TAP report bytes are required");
  validateCaptureTap(tap.toString("utf8"), profile);
  const images = expectedCaptureNames(profile).map((file) => {
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
    profile,
    runId,
    runAttempt,
    reportSha256: sha256(tap),
    limitations:
      "Fixture loads and hooks do not verify authentication, real route loading, or production.",
    images,
  };
}
