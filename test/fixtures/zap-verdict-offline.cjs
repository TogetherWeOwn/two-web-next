// Acceptance-owned child-only safety fence. No report or production behavior here.
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

function deny() {
  fs.appendFileSync(process.env.ZAP_ACCEPTANCE_DENIED, "denied\n");
  throw new Error("offline acceptance fence: external operation refused");
}

for (const name of ["node:http", "node:https"]) {
  const mod = require(name);
  mod.request = deny;
  mod.get = deny;
}
for (const name of ["node:net", "node:tls"]) {
  const mod = require(name);
  mod.connect = deny;
  mod.createConnection = deny;
}
require("node:net").Socket.prototype.connect = deny;
require("node:dgram").createSocket = deny;
for (const key of Object.keys(require("node:dns"))) {
  if (/^(lookup|resolve|reverse)/.test(key)) require("node:dns")[key] = deny;
}
for (const key of Object.keys(require("node:dns").promises)) {
  if (/^(lookup|resolve|reverse)/.test(key)) require("node:dns").promises[key] = deny;
}
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  require("node:child_process")[key] = deny;
}
require("node:worker_threads").Worker = deny;
globalThis.fetch = deny;
globalThis.WebSocket = deny;
syncBuiltinESMExports();
