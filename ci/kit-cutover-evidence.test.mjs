import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourceInputs, verifyPackage, writeManifest } from "./kit-cutover-evidence.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const identity = { runId: "21", runAttempt: "3" };
const inputs = await sourceInputs();

test("cutover packet refuses wrong bytes, package identity, or source config", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-packet-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const profile of ["hono", "kit"]) {
    await mkdir(join(scratch, profile, "modules"), { recursive: true });
    await mkdir(join(scratch, profile, "assets"));
    await writeFile(join(scratch, profile, "assets", ".assetsignore"), "fixture");
  }
  await writeFile(join(scratch, "hono/modules/worker.js"), "pure Hono");
  await writeFile(join(scratch, "kit/modules/_worker.js"), "facade");
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  const pin = { ...context, digest: await writeManifest(scratch, context, inputs) };
  await verifyPackage(scratch, pin, inputs);
  await assert.rejects(verifyPackage(scratch, { ...pin, digest }, inputs), /manifest digest/);
  for (const [field, value] of [
    ["sourceSha", "d".repeat(40)],
    ["runId", "22"],
    ["runAttempt", "4"],
  ]) {
    await assert.rejects(
      verifyPackage(scratch, { ...pin, [field]: value }, inputs),
      new RegExp(field),
    );
  }
  await assert.rejects(
    verifyPackage(scratch, pin, {
      digests: { ...inputs.digests, honoConfig: digest },
    }),
    /config or journal digest/,
  );
  await assert.rejects(
    verifyPackage(scratch, pin, {
      ...inputs,
      honoBuild: { ...inputs.honoBuild, define: "__TWO_WEB_1033_COMPAT__:false" },
    }),
    /Hono build profile/,
  );
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "changed");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /kit bytes mismatch/);
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  await writeFile(join(scratch, "hono/assets/.assetsignore"), "changed Hono asset control file");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /hono bytes mismatch/);
});
