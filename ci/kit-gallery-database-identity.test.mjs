import assert from "node:assert/strict";
import test from "node:test";
import { validateGalleryDatabaseIdentity } from "./kit-gallery-database-identity.mjs";

function fixture() {
  const serviceId = "a".repeat(64);
  return {
    serviceId,
    port: "32769",
    databaseUrl: "postgres://postgres:ci@127.0.0.1:32769/postgres",
    inspect: [
      {
        Id: serviceId,
        State: { Running: true },
        Config: { Image: "postgres:17" },
        NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "32769" }] } },
      },
    ],
  };
}

test("accepts matching service metadata without connecting", () => {
  assert.equal(validateGalleryDatabaseIdentity(fixture()), true);
});

test("accepts matching IPv4 and IPv6 bindings in either order", () => {
  for (const reverse of [false, true]) {
    const input = fixture();
    const bindings = input.inspect[0].NetworkSettings.Ports["5432/tcp"];
    bindings.push({ HostIp: "::", HostPort: input.port });
    if (reverse) bindings.reverse();
    assert.equal(validateGalleryDatabaseIdentity(input), true);
  }
});

test("accepts valid port boundaries", () => {
  for (const port of ["1", "65535"]) {
    const input = fixture();
    input.port = port;
    input.databaseUrl = `postgres://postgres:ci@127.0.0.1:${port}/postgres`;
    input.inspect[0].NetworkSettings.Ports["5432/tcp"][0].HostPort = port;
    assert.equal(validateGalleryDatabaseIdentity(input), true);
  }
});

test("rejects mismatched endpoints and service metadata", () => {
  const changes = [
    (x) => {
      x.serviceId = "a".repeat(12);
    },
    (x) => {
      x.port = "65536";
    },
    (x) => {
      x.port = "0";
    },
    (x) => {
      x.databaseUrl = "not a URL";
    },
    (x) => {
      x.databaseUrl = "https://postgres:ci@127.0.0.1:32769/postgres";
    },
    (x) => {
      x.databaseUrl = "postgres://other:ci@127.0.0.1:32769/postgres";
    },
    (x) => {
      x.databaseUrl = "postgres://postgres:wrong@127.0.0.1:32769/postgres";
    },
    (x) => {
      x.databaseUrl = "postgres://postgres:ci@127.0.0.1:32769/other";
    },
    (x) => {
      x.databaseUrl += "#fragment";
    },
    (x) => {
      x.inspect = null;
    },
    (x) => {
      x.databaseUrl = "postgres://postgres:ci@localhost:32769/postgres";
    },
    (x) => {
      x.databaseUrl += "?host=elsewhere";
    },
    (x) => {
      x.databaseUrl = "postgres://postgres:ci@127.0.0.1:32770/postgres";
    },
    (x) => {
      x.inspect[0].Id = "b".repeat(64);
    },
    (x) => {
      x.inspect[0].State.Running = false;
    },
    (x) => {
      x.inspect[0].Config.Image = "postgres:16";
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"][0].HostPort = "32770";
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"][0].HostIp = "192.0.2.1";
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"].push({ HostIp: "::", HostPort: "32770" });
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"].push({ HostIp: "::1", HostPort: x.port });
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"].push({ HostIp: "::", HostPort: x.port });
      x.inspect[0].NetworkSettings.Ports["5432/tcp"].push({ HostIp: "::", HostPort: x.port });
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"].push({
        HostIp: "127.0.0.1",
        HostPort: x.port,
      });
    },
    (x) => {
      x.inspect[0].NetworkSettings.Ports["5432/tcp"] = [{ HostIp: "::", HostPort: x.port }];
    },
    (x) => {
      x.inspect.push(x.inspect[0]);
    },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => validateGalleryDatabaseIdentity(input));
  }
});
