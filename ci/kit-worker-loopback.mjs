import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

const loopback = "127.0.0.1";
const maxAttempts = 3;

export function tail(value, limit = 4000) {
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

async function unusedPort() {
  const server = createServer().listen(0, loopback);
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function trackWorker(name, child, origin, port, workers) {
  const worker = { name, child, origin, log: "", bound: false, stopped: false };
  worker.closed = new Promise((done) => {
    child.once("close", () => {
      worker.stopped = true;
      done();
    });
  });
  workers.push(worker);
  child.on("error", (error) => {
    worker.log += `\n${error.message}`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (data) => {
      worker.log += data.toString();
    });
  }
  child.on("message", (message) => {
    if (typeof message !== "string") return;
    let ready;
    try {
      ready = JSON.parse(message);
    } catch {
      return; // Ignore non-Wrangler IPC messages.
    }
    if (ready?.event === "DEV_SERVER_READY" && ready.ip === loopback && ready.port === port) {
      worker.bound = true;
    }
  });
  return worker;
}

async function waitForBind(worker, deadline, signal) {
  const { child, origin } = worker;
  while (!worker.bound && !worker.stopped && Date.now() < deadline) {
    await delay(100, undefined, { signal });
  }
  signal?.throwIfAborted();
  if (worker.stopped) {
    throw new Error(
      `Wrangler dev exited before ready (exit ${child.exitCode ?? child.signalCode}). Worker output:\n${tail(worker.log)}`,
    );
  }
  if (!worker.bound) {
    throw new Error(
      `Timed out waiting for Wrangler to bind ${origin}. Worker output:\n${tail(worker.log)}`,
    );
  }
}

export async function startLoopbackWorker(
  name,
  launch,
  workers,
  { selectPort = unusedPort, signal } = {},
) {
  const deadline = Date.now() + 60_000;
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    const port = await selectPort();
    signal?.throwIfAborted();
    const origin = `http://${loopback}:${port}`;
    const child = await launch(port, origin);
    const worker = trackWorker(name, child, origin, port, workers);
    try {
      await waitForBind(worker, deadline, signal);
      return worker;
    } catch (error) {
      const collision = `Address already in use (${loopback}:${port}). Please check that you are not already running a server on this address or specify a different port with --port.`;
      if (
        attempt >= maxAttempts ||
        Date.now() >= deadline ||
        signal?.aborted ||
        !worker.stopped ||
        worker.bound ||
        child.exitCode !== 1 ||
        !stripVTControlCharacters(worker.log).includes(collision)
      ) {
        throw error;
      }
      console.log(`Loopback bind collision for ${name} Worker, retrying with a fresh port`);
    }
  }
}
