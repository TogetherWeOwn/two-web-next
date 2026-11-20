// Wire-size budgets (including encoding overhead); field validation still runs
// independently. See docs/body-limits.md for the legacy-maxima derivation.
export const BODY_LIMIT_BYTES = {
  form: 64 * 1024,
  json: 32 * 1024,
  agent: 32 * 1024,
  mcp: 32 * 1024,
  featured: 256 * 1024,
  action: 4 * 1024,
} as const;
export type BodyClass = keyof typeof BODY_LIMIT_BYTES;

type BodyLimitResult = { ok: true; request: Request } | { ok: false; status: 400 | 413 };

function overflow(source: Pick<ReadableStream<Uint8Array>, "cancel"> | null) {
  // Cancellation can hang or reject. Neither can change an already-decided refusal.
  void source?.cancel().catch(() => {
    // The caller still receives 413.
  });
  return { ok: false, status: 413 } as const;
}

// Run before parsing, then use the returned request instead of the consumed one.
// The caller owns the response envelope and admission order.
export async function limitRequestBody(
  request: Request,
  kind: BodyClass,
): Promise<BodyLimitResult> {
  const max = BODY_LIMIT_BYTES[kind];
  if (Number(request.headers.get("content-length")) > max) return overflow(request.body);
  if (!request.body) return { ok: true, request };

  const reader = request.body.getReader();
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, status: 400 };
      }
      if (chunk.done) break;
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > max) return overflow(reader);
      if (nextSize > bytes.byteLength) {
        const buffer = new Uint8Array(
          Math.min(max, Math.max(4096, nextSize, bytes.byteLength * 2)),
        );
        buffer.set(bytes);
        bytes = buffer;
      }
      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, request: new Request(request, { body: bytes.subarray(0, size) }) };
}
