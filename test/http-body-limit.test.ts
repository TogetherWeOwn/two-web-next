import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestBodyLimit } from "../src/body-limit";
import type { Env } from "../src/env";
import { type BodyClass, limitRequestBody } from "../src/http/body-limit";

const contentType = "application/octet-stream";

function upload(body: RequestInit["body"], length?: string) {
  const headers = new Headers({ "content-type": contentType });
  if (length !== undefined) headers.set("content-length", length);
  return new Request("https://example.test/upload", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}

const implementations = {
  Hono: (kind: BodyClass, request: Request) => {
    const app = new Hono<{ Bindings: Env }>();
    app.post(
      "/upload",
      requestBodyLimit(kind),
      (c) => new Response(c.req.raw.body, { headers: c.req.raw.headers }),
    );
    return app.request(request);
  },
  Fetch: async (kind: BodyClass, request: Request) => {
    const result = await limitRequestBody(request, kind);
    return result.ok
      ? new Response(result.request.body, { headers: result.request.headers })
      : new Response(null, { status: result.status });
  },
};

const limits = {
  form: 65536,
  json: 32768,
  agent: 32768,
  mcp: 32768,
  featured: 262144,
  action: 4096,
};

describe.each(Object.entries(implementations))("%s body cap contract", (_name, run) => {
  it.each(Object.entries(limits) as [BodyClass, number][])(
    "admits %s at the byte limit and rejects one more byte",
    async (kind, max) => {
      const body = new Uint8Array(max).fill(0x5a).fill(0xa5, max / 2);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, max / 2));
          controller.enqueue(body.subarray(max / 2));
          controller.close();
        },
      });
      const accepted = await run(kind, upload(stream, "invalid"));
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("content-type")).toBe(contentType);
      expect(accepted.headers.get("content-length")).toBe("invalid");
      expect(new Uint8Array(await accepted.arrayBuffer())).toEqual(body);
      expect((await run(kind, upload(new Uint8Array(max + 1), "1"))).status).toBe(413);
    },
  );

  it.each(["4097", "1"])("refuses without awaiting cancellation (length %s)", async (length) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(3000));
      if (pull.mock.calls.length === 3) controller.close();
    });
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    expect((await run("action", upload(body, length))).status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(length === "4097" ? 0 : 2);
    expect(body.locked).toBe(false);
  });

  it("admits bodyless requests", async () => {
    const response = await run("action", upload(null));
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it("reports a failed stream read as 400 and releases the reader", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("upload disconnected"));
      },
    });
    expect((await run("action", upload(body))).status).toBe(400);
    expect(body.locked).toBe(false);
  });
});
