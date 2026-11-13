import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { validateGalleryDatabaseIdentity } from "./kit-gallery-database-identity.mjs";

test("hosted service metadata and negative controls", () => {
  const serviceId = process.env.GALLERY_SERVICE_ID;
  const port = process.env.GALLERY_SERVICE_PORT;
  assert.match(serviceId ?? "", /^[a-f0-9]{64}$/);
  assert.match(port ?? "", /^[1-9][0-9]{0,4}$/);
  const inspect = JSON.parse(
    execFileSync("docker", ["inspect", serviceId], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
  );
  const input = { serviceId, port, databaseUrl: process.env.DATABASE_URL, inspect };
  assert.equal(validateGalleryDatabaseIdentity(input), true);

  for (const mutate of [
    (x) => {
      x.serviceId = "f".repeat(64) === serviceId ? "e".repeat(64) : "f".repeat(64);
    },
    (x) => {
      x.port = port === "1" ? "2" : "1";
    },
    (x) => {
      x.databaseUrl = "postgres://postgres:ci@localhost:5432/postgres";
    },
    (x) => {
      x.inspect[0].State.Running = false;
    },
    (x) => {
      x.inspect[0].Config.Image = "postgres:16";
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"] = [];
    },
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    assert.throws(() => validateGalleryDatabaseIdentity(candidate));
  }
});
