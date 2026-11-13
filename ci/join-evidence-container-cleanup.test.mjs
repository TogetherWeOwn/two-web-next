import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupWithoutId,
  ContainerCleanupError,
  inspectContainer,
  ownerLabel,
  removeOwned,
} from "./join-evidence-container-cleanup.mjs";

const id = "a".repeat(64);
const token = "owner";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false, drained: true });
const missing = {
  code: 1,
  stdout: "",
  stderr: "Error: No such object: x",
  timedOut: false,
  drained: true,
};
const present = (owner = token) =>
  ok(JSON.stringify({ State: { Running: false, ExitCode: 0 }, Labels: { [ownerLabel]: owner } }));

function scripted(results) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    assert.ok(results.length, `unexpected ${args[0]}`);
    const [verb, result] = results.shift();
    assert.equal(args[0], verb);
    return result;
  };
  return { docker, calls };
}

test("inspection fails closed for incomplete, timed-out, and malformed responses", async () => {
  for (const result of [
    { ...missing, drained: false },
    { ...missing, timedOut: true },
    ok("not json"),
    ok(JSON.stringify({ State: {}, Labels: {} })),
    { ...missing, stderr: "daemon unavailable" },
  ]) {
    const { docker } = scripted([["inspect", result]]);
    assert.equal((await inspectContainer(docker, id, 1000)).status, "unknown");
  }
  const { docker } = scripted([["inspect", missing]]);
  assert.equal((await inspectContainer(docker, id, 1000)).status, "missing");
});

test("cleanup verifies ownership and disappearance before reporting success", async () => {
  const { docker, calls } = scripted([
    ["inspect", present()],
    ["kill", ok()],
    ["rm", ok()],
    ["inspect", missing],
  ]);
  await removeOwned(docker, id, token, 1000);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["inspect", "kill", "rm", "inspect"],
  );
  assert.equal(calls[2].at(-1), id);
});

test("cleanup leaves a foreign container untouched", async () => {
  const { docker, calls } = scripted([["inspect", present("foreign")]]);
  await assert.rejects(
    removeOwned(docker, id, token, 1000),
    (error) => error instanceof ContainerCleanupError && !error.cleanupVerified,
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["inspect"],
  );
});

test("cleanup rejects an inconclusive or still-present final inspection", async () => {
  for (const final of [
    present(),
    { ...missing, drained: false },
    { ...missing, stderr: "daemon unavailable" },
  ]) {
    const { docker } = scripted([
      ["inspect", present()],
      ["kill", ok()],
      ["rm", ok()],
      ["inspect", final],
    ]);
    await assert.rejects(removeOwned(docker, id, token, 1000), ContainerCleanupError);
  }
});

test("ambiguous create remains unverified after removing visible owned containers", async () => {
  const { docker, calls } = scripted([
    ["ps", ok(`${id}\n`)],
    ["inspect", present()],
    ["kill", ok()],
    ["rm", ok()],
    ["inspect", missing],
  ]);
  await assert.rejects(
    cleanupWithoutId(docker, token, 1000),
    (error) => error instanceof ContainerCleanupError && /ambiguous/.test(error.message),
  );
  assert.ok(calls[0].includes(`label=${ownerLabel}=${token}`));
});

test("an empty ownership lookup cannot prove an ambiguous create was cleaned up", async () => {
  const { docker, calls } = scripted([["ps", ok()]]);
  await assert.rejects(
    cleanupWithoutId(docker, token, 1000),
    (error) =>
      error instanceof ContainerCleanupError &&
      error.cleanupVerified === false &&
      /ambiguous/.test(error.message),
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["ps"],
  );
});

test("ambiguous create refuses incomplete or malformed ownership listings", async () => {
  for (const listing of [
    { ...ok(id), drained: false },
    ok("not-an-id"),
    { ...missing, stderr: "daemon unavailable" },
  ]) {
    const { docker, calls } = scripted([["ps", listing]]);
    await assert.rejects(cleanupWithoutId(docker, token, 1000), ContainerCleanupError);
    assert.equal(calls.length, 1);
  }
});
