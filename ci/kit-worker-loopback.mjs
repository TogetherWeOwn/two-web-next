import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

const loopback = "127.0.0.1";
const maxAttempts = 3;

export const tail = (value) => (value.length > 4000 ? `…${value.slice(-4000)}` : value);

export async function unusedPort() {
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

export async function waitForBind(worker, deadline, signal) {
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
  if (!worker.bound || Date.now() >= deadline) {
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
      // A paired launch may still be binding. Start HTTP now and pass its
      // outcome back to the caller without an unhandled rejection.
      const ready = waitForHttpReady(worker, deadline, signal);
      worker.readiness = ready.then(
        () => null,
        (error) => ({ error }),
      );
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

export async function waitForHttpReady(worker, deadline, signal) {
  const { child, origin } = worker;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (exited()) {
      throw new Error(
        `Wrangler dev exited before ready (exit ${child.exitCode ?? child.signalCode}). Worker output:\n${tail(worker.log)}`,
      );
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now())));
    try {
      const response = await fetch(`${origin}/favicon.ico`, {
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      lastStatus = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (response.ok && !exited() && !signal?.aborted && Date.now() < deadline) return;
    } catch {
      // The bound listener is not serving the readiness request yet.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(250, remaining), undefined, { signal });
  }
  throw new Error(
    `Timed out waiting for ${origin}/favicon.ico (${lastStatus}). Worker output:\n${tail(worker.log)}`,
  );
}
