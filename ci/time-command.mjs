import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const [phase, separator, command, ...args] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*$/.test(phase ?? "") || separator !== "--" || !command) {
  console.error("Usage: node ci/time-command.mjs phase -- command [args...]");
  process.exit(2);
}
const start = performance.now();
// Inherit the existing invocation unchanged; never log arguments or env values.
const child = spawn(command, args, { stdio: "inherit" });
let finished = false;
function finish(code, signal) {
  if (finished) return;
  finished = true;
  console.log(`TWO_TEST_TIMING ${JSON.stringify({
    kind: "command", phase, elapsedMs: performance.now() - start, exitCode: code, signal,
  })}`);
  if (signal) {
    const relay = signalHandlers.get(signal);
    if (relay) process.removeListener(signal, relay);
    process.kill(process.pid, signal);
  } else process.exitCode = code ?? 1;
}
child.on("error", () => finish(1, null));
child.on("exit", finish);
const signalHandlers = new Map();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  const relay = () => child.kill(signal);
  signalHandlers.set(signal, relay);
  process.on(signal, relay);
}
