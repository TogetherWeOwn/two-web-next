import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "./env";
import { payloadTooLarge } from "./errors";

// Wire-size budgets (including encoding overhead); field validation still runs
// independently. See docs/body-limits.md for the legacy-maxima derivation.
export const BODY_LIMIT_BYTES = {
  form: 64 * 1024,
  json: 32 * 1024,
  agent: 32 * 1024,
  featured: 256 * 1024,
  action: 4 * 1024,
} as const;
export type BodyClass = keyof typeof BODY_LIMIT_BYTES;
const LIMITED = Symbol("body-limited");

export function requestBodyLimit(kind: BodyClass): MiddlewareHandler<{ Bindings: Env }> {
  const maxSize = BODY_LIMIT_BYTES[kind];
  const middleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    const length = c.req.header("content-length");
    if (length !== undefined && Number(length) > maxSize) {
      await c.req.raw.body?.cancel().catch(() => {});
      return payloadTooLarge(c);
    }
    if (!c.req.raw.body) return next();

    // Retain the source reader so overflow cancels the upload. Hono's own
    // reader is locked inside bodyLimit and cannot be cancelled by onError.
    const reader = c.req.raw.body.getReader();
    let readFailed = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (err) {
          readFailed = true;
          controller.error(err);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 });

    // Hono trusts Content-Length without counting the stream. Remove that
    // shortcut even for understated/invalid lengths, then restore the header
    // for downstream handlers after Hono has verified the actual bytes.
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    c.req.raw = new Request(c.req.raw, { headers, body, duplex: "half" } as RequestInit);
    const limit = bodyLimit({
      maxSize,
      onError: async () => {
        await reader.cancel().catch(() => {});
        return payloadTooLarge(c);
      },
    });
    let refused: Response | void;
    try {
      // Buffering is separate from downstream execution: only a failed source
      // read is a bad upload, never a route/store exception.
      refused = await limit(c, async () => {});
    } catch (err) {
      if (!readFailed) throw err;
      return c.text("Bad request", 400);
    } finally {
      reader.releaseLock();
    }
    if (refused) return refused;
    if (length !== undefined) c.req.raw.headers.set("content-length", length);
    return next();
  };
  (middleware as unknown as Record<symbol, BodyClass>)[LIMITED] = kind;
  return middleware;
}

export const bodyLimitClass = (handler: unknown): BodyClass | undefined =>
  typeof handler === "function" ? (handler as unknown as Record<symbol, BodyClass>)[LIMITED] : undefined;
