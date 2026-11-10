// Route-parity recording harness (docs/kit-parity-gates.md, "Pure-Hono route
// parity goldens"). Wraps a built Worker so two recordings of the same build
// are comparable byte for byte. Test entry only: ci/parity/record.mjs
// generates a one-line entry that imports a target Worker and this wrapper,
// and runs it under `wrangler dev --local` against a disposable database.
//
// Per request it pins every input the recorder does not send itself:
// - the JS clock is frozen at PARITY_EPOCH_MS;
// - crypto.getRandomValues/randomUUID are reseeded from the vector id;
// - cf-ray (so the request id) and cf-connecting-ip (so the throttle client
//   key) are derived from the vector id and the recorder's client address;
// - outbound fetch answers only the shared Discord fixture and refuses the
//   rest, so no request leaves the process.
// It reports what the response alone cannot show: the request-log route the
// app matched (the tail alert-line label source), any error.alert route, and
// the outbound calls the request attempted.
import { discordFixtureResponse } from "../../e2e/discord-stub";

/** 2026-07-01T12:00:00Z: a fixed instant before every real run date. */
export const PARITY_EPOCH_MS = Date.UTC(2026, 6, 1, 12, 0, 0);
export const VECTOR_HEADER = "x-parity-vector";
export const CLIENT_HEADER = "x-parity-client";
export const READY_PATH = "/__parity/ready";

type InnerWorker = {
  fetch: (request: Request, env: never, ctx: ExecutionContext) => Response | Promise<Response>;
};
type HarnessEnv = { APP_URL?: string } & Record<string, unknown>;
type Capture = { requestId: string; route: string | null; alerts: string[]; outbound: string[] };

const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(PARITY_EPOCH_MS);
    else super(...(args as [string | number]));
  }
  static override now(): number {
    return PARITY_EPOCH_MS;
  }
}
globalThis.Date = FrozenDate as DateConstructor;

/** FNV-1a 64-bit, hex: stable ids from vector names without async crypto. */
export function stableHex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

// mulberry32: small, deterministic, good enough for nonces and tokens that
// only need to repeat across two recordings.
let seed = 0;
function nextRandom(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}
function reseed(vector: string): void {
  seed = Number.parseInt(stableHex(vector).slice(0, 8), 16) | 0;
}

function seededRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (!array) return array;
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < bytes.length; i++) bytes[i] = nextRandom() & 0xff;
  return array;
}
function seededUuid(): `${string}-${string}-${string}-${string}-${string}` {
  const b = seededRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// Reported on the readiness probe: a runtime that refuses the override still
// records, and the recorder fails loudly instead of trusting random bodies.
let randomSeeded = false;
try {
  Object.defineProperty(crypto, "getRandomValues", { value: seededRandomValues, writable: true });
  Object.defineProperty(crypto, "randomUUID", { value: seededUuid, writable: true });
  randomSeeded = crypto.getRandomValues === (seededRandomValues as unknown);
} catch (error) {
  console.error(`parity harness could not seed crypto: ${(error as Error).name}`);
  randomSeeded = false;
}

let current: Capture | null = null;
function observe(args: unknown[]): void {
  if (!current || typeof args[0] !== "string" || !args[0].startsWith("{")) return;
  let line: Record<string, unknown>;
  try {
    line = JSON.parse(args[0]) as Record<string, unknown>;
  } catch {
    return;
  }
  if (line.event === "http.request" && line.request_id === current.requestId) {
    current.route = typeof line.route === "string" ? line.route : null;
  } else if (line.event === "error.alert" && typeof line.route === "string") {
    current.alerts.push(line.route);
  }
}
for (const level of ["log", "error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    observe(args);
    original(...args);
  };
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const call = `${request.method} ${url.origin}${url.pathname}`;
  current?.outbound.push(call);
  const fixture = await discordFixtureResponse(request);
  if (fixture) return fixture;
  throw new Error(`Parity harness blocked unmocked outbound fetch: ${call}`);
};

export function parityWorker(inner: InnerWorker) {
  return {
    async fetch(request: Request, env: HarnessEnv, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === READY_PATH) return Response.json({ ready: true, randomSeeded });
      const vector = request.headers.get(VECTOR_HEADER);
      const client = request.headers.get(CLIENT_HEADER);
      if (!vector || !client || !env.APP_URL) {
        return new Response("parity harness needs a vector id, a client and APP_URL", {
          status: 400,
        });
      }
      reseed(vector);
      const requestId = stableHex(`ray:${vector}`);
      const capture: Capture = { requestId, route: null, alerts: [], outbound: [] };
      current = capture;
      // Same virtual-origin translation as e2e/worker.ts: TrustHosts needs the
      // Host header and request URL on APP_URL. The recorder sends any Origin
      // it wants verbatim, so no Origin rewrite happens here.
      const virtual = new URL(url.pathname + url.search, env.APP_URL);
      const headers = new Headers(request.headers);
      headers.delete(VECTOR_HEADER);
      headers.delete(CLIENT_HEADER);
      headers.set("host", virtual.host);
      headers.set("cf-ray", requestId);
      headers.set("cf-connecting-ip", client);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const mapped = new Request(virtual, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : null,
        redirect: "manual",
      });
      try {
        // Kit reads the ambient cloudflare:workers env, not a spread copy.
        // Both targets must observe the same healthy-empty Discord fixture.
        env.DISCORD_EVENTS = { upcoming: async () => [], lastReadFailed: () => false };
        const response = await inner.fetch(mapped, env as never, ctx);
        const out = new Response(response.body, response);
        out.headers.set("x-parity-route", capture.route ?? "");
        out.headers.set("x-parity-alerts", JSON.stringify(capture.alerts));
        out.headers.set("x-parity-outbound", JSON.stringify(capture.outbound));
        return out;
      } finally {
        current = null;
      }
    },
  };
}
