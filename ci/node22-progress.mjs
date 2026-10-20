import { closeSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_PROCESSES = 32;
const MAX_READ_BYTES = 8192;
const INTERVAL_MS = 60000;
const MAX_SAMPLES = 28;

// Read only stat and main-thread child IDs, never cmdline/environ, process
// names, stack/heap reports or test output. Even diagnostic errors stay fixed.
function readProc(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(MAX_READ_BYTES + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    return size <= MAX_READ_BYTES ? bytes.toString("utf8", 0, size) : null;
  } catch {
    return null; // A process can exit between tree discovery and this read.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resourceRow(pid, stat) {
  if (!stat?.startsWith(`${pid} (`)) return null;
  // comm may contain spaces and parentheses; its contents never enter output.
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const values = [1, 11, 12, 17, 19, 21].map((i) =>
    /^\d+$/.test(fields[i] ?? "") ? Number(fields[i]) : NaN,
  );
  if (!/^[RSDZTtXxKWPI]$/.test(fields[0]) || !values.every(Number.isSafeInteger)) return null;
  const [ppid, userTicks, systemTicks, threads, startTicks, rssPages] = values;
  const cpuTicks = userTicks + systemTicks;
  if (!Number.isSafeInteger(cpuTicks)) return null;
  return { pid, ppid, state: fields[0], cpuTicks, rssPages, threads, startTicks };
}

export function sampleProcesses(
  rootPid,
  { procRoot = "/proc", selfPid = process.pid, maxProcesses = MAX_PROCESSES } = {},
) {
  if (
    !Number.isSafeInteger(rootPid) ||
    rootPid < 1 ||
    !Number.isInteger(maxProcesses) ||
    maxProcesses < 1 ||
    maxProcesses > MAX_PROCESSES
  ) {
    throw new Error("Invalid process snapshot bounds");
  }
  const processes = [];
  const pending = [rootPid];
  const seen = new Set([selfPid]);
  let truncated = false;
  // Bound reads and output even for a rapidly growing or malformed tree.
  for (let i = 0; i < pending.length && i < maxProcesses; i++) {
    const pid = pending[i];
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = resourceRow(pid, readProc(`${procRoot}/${pid}/stat`));
    if (!row) {
      if (pid === rootPid) return null;
      truncated = true;
      continue;
    }
    processes.push(row);
    const children = readProc(`${procRoot}/${pid}/task/${pid}/children`);
    if (children === null || !/^[\d\s]*$/.test(children)) {
      truncated = true;
      continue;
    }
    for (const id of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
      if (seen.has(id) || pending.includes(id)) continue;
      if (!Number.isSafeInteger(id) || id < 1 || pending.length >= maxProcesses) truncated = true;
      else pending.push(id);
    }
  }
  return { processes, truncated };
}

// This observer owns only its timer: it never launches, signals, retries or
// changes the status of the tests. Lower limits allow fast controlled fixtures;
// the CLI always uses the fixed production caps, independent of environment.
export function startProgress(
  rootPid,
  {
    intervalMs = INTERVAL_MS,
    maxSamples = MAX_SAMPLES,
    write = (line) => process.stderr.write(line),
    ...options
  } = {},
) {
  if (
    !Number.isSafeInteger(rootPid) ||
    rootPid < 1 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > INTERVAL_MS ||
    !Number.isInteger(maxSamples) ||
    maxSamples < 1 ||
    maxSamples > MAX_SAMPLES
  ) {
    throw new Error("Invalid progress sampler bounds");
  }
  const started = performance.now();
  let timer;
  let stopped = false;
  let samples = 0;
  let rootStart;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const tick = () => {
    if (stopped) return;
    const snapshot = sampleProcesses(rootPid, options);
    if (!snapshot || (rootStart !== undefined && rootStart !== snapshot.processes[0]?.startTicks)) {
      write('[node22-progress] {"status":"root-unavailable"}\n');
      stop();
      return;
    }
    rootStart = snapshot.processes[0].startTicks;
    const record = {
      elapsedSeconds: Math.floor((performance.now() - started) / 1000),
      rootPid,
      ...snapshot,
    };
    write(`[node22-progress] ${JSON.stringify(record)}\n`);
    if (++samples >= maxSamples) stop();
    else timer = setTimeout(tick, intervalMs);
  };
  tick();
  return stop;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    startProgress(Number(process.argv[2]));
  } catch {
    console.error('[node22-progress] {"status":"sampler-unavailable"}');
  }
}
