import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { join } from "node:path";

const databaseModule = new URL("../kit-cutover-database.mjs", import.meta.url).href;
const statePath = join(process.env.RUNNER_TEMP, "database-fixture.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const claimPath = join(process.env.RUNNER_TEMP, "kit-cutover-claimed.json");
const workerSettings = `scripts/${state.worker}/settings`;

function record(event) {
  state.events.push(event);
  writeFileSync(statePath, JSON.stringify(state));
}

// Prevent network access even if a future change bypasses a fixture.
Socket.prototype.connect = () => assert.fail("unexpected network connection");
globalThis.fetch = async (url, { method }) => {
  const root = "/client/v4/accounts/00000000000000000000000000000000/workers/";
  assert.equal(new URL(url).origin, "https://api.cloudflare.com");
  assert.equal(method, "GET");
  const path = new URL(url).pathname;
  if (path === `${root}subdomain`) {
    return Response.json({ success: true, result: { subdomain: "offline-fixture" } });
  }
  assert.equal(path, `${root}${workerSettings}`);
  record("check-worker-settings");
  return new Response(null, { status: 404 });
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "postgres" && context.parentURL === databaseModule) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export default function postgres(url) {
  assert.equal(new URL(url).pathname, "/two_web_cutover");
  function sql(strings, ...values) {
    if (typeof strings === "string") return strings;
    const [resource, login] = values;
    switch (strings.join("?").replace(/\s+/g, " ").trim()) {
      case "SELECT current_user = pg_get_userbyid(datdba) AS owned FROM pg_database WHERE datname = current_database()":
        return [{ owned: true }];
      case "SELECT EXISTS (SELECT FROM pg_database WHERE datname = ?) AS db, EXISTS (SELECT FROM pg_roles WHERE rolname = ?) AS login":
        record(["inspect", resource, login]);
        return [{ db: state.databases.includes(resource), login: state.logins.includes(login) }];
      case "REVOKE CONNECT ON DATABASE two_web_cutover FROM PUBLIC":
        return [];
      case "CREATE DATABASE ? TEMPLATE template0":
        assert.equal(readFileSync(claimPath, "utf8"), state.worker);
        assert.equal(state.databases.includes(resource), false);
        state.databases.push(resource);
        record(["create-database", resource]);
        return [];
      case "REVOKE CONNECT ON DATABASE ? FROM PUBLIC":
        assert.ok(state.databases.includes(resource));
        return [];
      case "CREATE ROLE ? LOGIN PASSWORD ? VALID UNTIL ?":
        record(["refuse-login", resource]);
        throw new Error("synthetic role setup failure");
      case "DROP DATABASE IF EXISTS ? WITH (FORCE)":
        state.databases = state.databases.filter((name) => name !== resource);
        record(["drop-database", resource]);
        return [];
      case "DROP ROLE IF EXISTS ?":
        state.logins = state.logins.filter((name) => name !== resource);
        record(["drop-login", resource]);
        return [];
      default:
        assert.fail("unexpected SQL in partial database fixture");
    }
  }
  sql.unsafe = () => Symbol("synthetic SQL fragment");
  sql.end = ({ timeout }) => {
    assert.equal(timeout, 0);
    record("close-control-connection");
  };
  return sql;
}
