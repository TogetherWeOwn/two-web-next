import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const [phase, separator, command, ...args] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*$/.test(phase ?? "") || separator !== "--" || !command) {
  console.error("Usage: node ci/time-command.mjs phase -- command [args...]");
  process.exit(2);
}
if (process.platform === "win32") {
  console.error("Timing command wrapper requires POSIX process groups.");
  process.exit(2);
}
const start = performance.now();
// A separate, still-referenced group lets cancellation reach npm's descendants.
// Source: https://nodejs.org/api/child_process.html#optionsdetached
// Inherit the existing invocation unchanged; never log arguments or env values.
const child = spawn(command, args, { stdio: "inherit", detached: true });
let finished = false;
let cancellationSignal;
let killTimer;
const signalHandlers = new Map();
function signalGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function finish(code, signal) {
  if (finished) return;
  finished = true;
  clearTimeout(killTimer);
  const terminationSignal = cancellationSignal ?? signal;
  // A launcher can exit before its descendants. Do not leave the owned group alive.
  if (terminationSignal) signalGroup("SIGKILL");
  console.log(`TWO_TEST_TIMING ${JSON.stringify({
    kind: "command", phase, elapsedMs: performance.now() - start, exitCode: code, signal: terminationSignal,
  })}`);
  if (terminationSignal) {
    for (const [name, relay] of signalHandlers) process.removeListener(name, relay);
    process.kill(process.pid, terminationSignal);
  } else process.exitCode = code ?? 1;
}
child.on("error", () => finish(1, null));
child.on("exit", finish);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  const relay = () => {
    cancellationSignal ??= signal;
    signalGroup(signal);
    // Bound cancellation cleanup if the command ignores the forwarded signal.
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 1000).unref();
  };
  signalHandlers.set(signal, relay);
  process.on(signal, relay);
}
