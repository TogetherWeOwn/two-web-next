// Child-process harness: drives get-uri's real "ftp:" loader against a loopback
// FTP server. Run as `node get-uri-ftp-fixture.mjs <lhci|browser-helper> <mdtm|list-fallback>`
// from the repository root. No external network is used; every socket and server
// is closed before exit, and a hard timer bounds the whole run.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [chain, scenario] = process.argv.slice(2);
assert.ok(["lhci", "browser-helper"].includes(chain), "unknown chain");
assert.ok(["mdtm", "list-fallback"].includes(scenario), "unknown scenario");

const guard = setTimeout(() => {
  console.error("get-uri ftp fixture timed out");
  process.exit(3);
}, 15000);

// Resolve get-uri only through declared dependency edges, like the pin test.
const root = createRequire(`${process.cwd()}/package.json`);
const lhci = createRequire(root.resolve("@lhci/cli/package.json"));
let req;
let expected;
if (chain === "lhci") {
  req = lhci;
  expected = "6.0.5";
} else {
  const lighthouse = createRequire(lhci.resolve("lighthouse/package.json"));
  const puppeteer = createRequire(lighthouse.resolve("puppeteer-core/package.json"));
  req = createRequire(puppeteer.resolve("@puppeteer/browsers/package.json"));
  expected = "8.0.1";
}
for (const name of ["proxy-agent", "pac-proxy-agent"]) {
  req = createRequire(join(dirname(dirname(req.resolve(name))), "package.json"));
}
// get-uri 8 exports its entry point but not package.json.
req = createRequire(join(dirname(dirname(req.resolve("get-uri"))), "package.json"));
assert.equal(req("./package.json").version, expected);
const mod = await import(
  pathToFileURL(join(dirname(req.resolve("./package.json")), "dist/index.js")).href
);
const getUri = mod.getUri ?? mod.default?.getUri;
assert.equal(typeof getUri, "function");

const body = "hello from the local ftp fixture\n";
const mdtmDate = "20240102030405";
const log = [];
const controls = new Set();
const dataServers = new Set();
const dataSockets = new Set();
let controlClosed;
const controlClosedPromise = new Promise((resolve) => {
  controlClosed = resolve;
});

const server = net.createServer((control) => {
  controls.add(control);
  control.setEncoding("utf8");
  let dataReady = null;
  const reply = (line) => control.write(`${line}\r\n`);
  const openData = () =>
    new Promise((resolveListen) => {
      const ds = net.createServer((socket) => {
        dataSockets.add(socket);
        socket.on("close", () => dataSockets.delete(socket));
        socket.on("error", () => {});
        dataReadyResolve(socket);
      });
      let dataReadyResolve;
      dataReady = new Promise((resolve) => {
        dataReadyResolve = resolve;
      });
      dataServers.add(ds);
      ds.listen(0, "127.0.0.1", () => resolveListen(ds.address().port));
    });
  const send = async (code150) => {
    const socket = await dataReady;
    reply("150 Opening data connection");
    await new Promise((resolve) => socket.end(code150, resolve));
    reply("226 Transfer complete");
  };
  let buffer = "";
  control.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const [cmd, ...rest] = line.split(" ");
      const verb = cmd.toUpperCase();
      log.push(verb);
      switch (verb) {
        case "FEAT":
          reply("211-Features:\r\n UTF8\r\n MLST type*;size*;modify*;\r\n211 End");
          break;
        case "USER":
          reply("331 Password required");
          break;
        case "PASS":
          reply("230 Logged in");
          break;
        case "TYPE":
        case "STRU":
        case "OPTS":
        case "PBSZ":
          reply("200 OK");
          break;
        case "MDTM":
          if (scenario === "mdtm") reply(`213 ${mdtmDate}`);
          else reply("500 MDTM not understood"); // deliberately not 550
          break;
        case "EPSV":
          openData()
            .then((port) => reply(`229 Entering Extended Passive Mode (|||${port}|)`))
            .catch((error) => control.destroy(error));
          break;
        case "PASV":
          openData()
            .then((port) =>
              reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`),
            )
            .catch((error) => control.destroy(error));
          break;
        case "MLSD":
          send(`type=file;size=33;modify=${mdtmDate}; file.txt\r\n`).catch((error) =>
            control.destroy(error),
          );
          break;
        case "RETR":
          assert.equal(rest.join(" "), "/pub/file.txt");
          send(body).catch((error) => control.destroy(error));
          break;
        case "QUIT":
          reply("221 Bye");
          control.end();
          break;
        default:
          reply("502 Command not implemented");
      }
    }
  });
  control.on("error", () => {});
  control.on("close", () => {
    controls.delete(control);
    if (log.includes("RETR")) controlClosed();
  });
  reply("220 fixture ready");
});

const closeServer = (s) => new Promise((resolve) => s.close(() => resolve()));
let failure;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const stream = await getUri(`ftp://user:pass@127.0.0.1:${port}/pub/file.txt`);
  assert.ok(stream.lastModified instanceof Date, "lastModified is a Date");
  if (scenario === "mdtm") {
    assert.equal(stream.lastModified.toISOString(), "2024-01-02T03:04:05.000Z");
  } else {
    assert.equal(Number.isNaN(+stream.lastModified), false);
  }
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString("utf8"), body);
  // client.close() runs after the download resolves: the server must see EOF.
  await controlClosedPromise;

  assert.ok(log.indexOf("USER") >= 0 && log.indexOf("PASS") > log.indexOf("USER"), "access");
  const mdtm = log.indexOf("MDTM");
  const list = log.indexOf("MLSD");
  const retr = log.indexOf("RETR");
  assert.ok(mdtm >= 0, "lastMod sent MDTM");
  assert.ok(retr > mdtm, "downloadTo sent RETR after MDTM");
  if (scenario === "mdtm") {
    assert.equal(list, -1, "LIST skipped when MDTM succeeds");
  } else {
    assert.ok(list > mdtm && list < retr, "non-550 MDTM error fell back to LIST before RETR");
  }
} catch (error) {
  failure = error;
} finally {
  clearTimeout(guard);
  for (const s of [...dataSockets, ...controls]) s.destroy();
  await Promise.all([...dataServers, server].map(closeServer));
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log(`ok ${chain} ${scenario} ${log.join(",")}`);
