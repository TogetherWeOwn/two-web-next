// One budget per Discord auth/join/role request, including response-body completion.
// A callback can make several sequential requests; this is not a journey-wide deadline.
export const DISCORD_HTTP_BUDGET_MS = 5_000;

export class DiscordHttpTimeoutError extends Error {
  constructor() {
    super("Discord HTTP operation timed out");
    this.name = "TimeoutError";
  }
}

/**
 * Return a fully buffered response so downstream JSON/text parsing cannot wait
 * on the network after headers. Own the reader so a locked, stalled body can be
 * cancelled, even with an injected transport that ignores the abort signal.
 * The race also bounds transports/cancellation hooks that never settle.
 */
export async function discordFetch(
  input: string,
  init: Omit<RequestInit, "signal"> = {},
  transport: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DiscordHttpTimeoutError());
    }, DISCORD_HTTP_BUDGET_MS);
  });

  const operation = (async () => {
    const res = await transport(input, { ...init, signal: controller.signal });
    // A non-cooperative transport may deliver headers after the race was lost.
    if (controller.signal.aborted) {
      void res.body?.cancel().catch(() => {});
      throw new DiscordHttpTimeoutError();
    }
    if (!res.body) return res;
    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
    } catch (error) {
      // Headers arrived, so the provider answered; an unreadable body is a
      // provider rejection, not a transport outage. Hand back an empty body
      // with the real status so downstream parsing classifies exactly as it
      // did when the body was consumed in place.
      void error;
      return new Response("", {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  })();

  try {
    const res = await Promise.race([operation, timeout]);
    complete = true;
    return res;
  } finally {
    clearTimeout(timer!);
    if (!complete) {
      controller.abort();
      // Do not await cancellation: the underlying source may itself be stuck.
      void reader?.cancel().catch(() => {});
    }
    reader?.releaseLock();
  }
}
