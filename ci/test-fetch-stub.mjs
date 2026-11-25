// Test-only fetch stub for CLI spawn tests (never imported by shipped code).
// Activated with `node --import ./ci/test-fetch-stub.mjs <script>`, it replaces
// the global fetch with canned responses from FETCH_STUB_JSON, a JSON array of
// `{ match, status, body, chunks, fail, sequence }`. The first entry whose `match`
// substring appears in the request URL wins; `sequence` serves one entry per
// call in order (for retry tests); `fail: true` rejects like a transport
// error. Anything unmatched rejects so a test never touches the network.
import { appendFileSync } from "node:fs";

const stubs = JSON.parse(process.env.FETCH_STUB_JSON ?? "[]");
const calls = new Map();
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  if (process.env.FETCH_STUB_LOG) appendFileSync(process.env.FETCH_STUB_LOG, `${url}\n`);
  for (const stub of stubs) {
    if (url.includes(stub.match)) {
      const n = (calls.get(stub.match) ?? 0) + 1;
      calls.set(stub.match, n);
      const behavior = Array.isArray(stub.sequence)
        ? stub.sequence[Math.min(n - 1, stub.sequence.length - 1)]
        : stub;
      if (behavior.fail) throw new TypeError("fetch failed");
      const status = behavior.status ?? 200;
      if (behavior.chunks) {
        const encoder = new TextEncoder();
        const chunks = behavior.chunks[Symbol.iterator]();
        const stream = new ReadableStream({
          pull(controller) {
            const { done, value } = chunks.next();
            if (done) controller.close();
            else controller.enqueue(encoder.encode(value));
          },
        });
        return new Response(stream, { status, statusText: behavior.statusText });
      }
      const body = behavior.body ?? {};
      return Response.json(body, { status });
    }
  }
  throw new Error(`unexpected fetch ${url}`);
};
