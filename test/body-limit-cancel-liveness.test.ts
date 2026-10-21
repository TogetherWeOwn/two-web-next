import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES, requestBodyLimit } from "../src/body-limit";
import type { Env } from "../src/env";

// Cancellation-liveness acceptance tests for the body-limit middleware.
//
// An overflow refusal (413) is already decided before the request body is
// cancelled. Returning it must not wait for request-owned cancellation to
// settle: a cancel promise that never settles (or rejects late) must not
// hold, change, or poison the refusal. Every case is bounded by a short
// real deadline raced against the request, so a hang fails in finite time
// instead of hanging the suite.

const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const MAX = BODY_LIMIT_BYTES.action;
const PENDING = Symbol("pending");
const DEADLINE_MS = 750;

function fixture(onDownstream: () => void) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/x", requestBodyLimit("action"), async (c) => {
    onDownstream();
    return c.json({ bytes: (await c.req.arrayBuffer()).byteLength });
  });
  return app;
}

async function within<T>(promise: Promise<T> | T, ms = DEADLINE_MS): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function streamRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string>) {
  return new Request("http://localhost/x", {
    method: "POST",
    body,
    duplex: "half",
    headers: { accept: "application/json", ...headers },
  } as RequestInit);
}

async function expectRefusal(response: Response | typeof PENDING) {
  expect(response, "413 refusal must settle before the deadline").not.toBe(PENDING);
  const res = response as Response;
  expect(res.status).toBe(413);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(await res.json()).toMatchObject(ERROR);
}

const neverSettles = () => new Promise<void>(() => {});

describe("overflow refusals do not wait for cancellation", () => {
  it("returns the advertised-overflow 413 even when cancel never settles", async () => {
    const downstream = vi.fn();
    const pull = vi.fn();
    const cancel = vi.fn(neverSettles);
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });

    const response = await within(
      fixture(downstream).request(streamRequest(body, { "content-length": String(MAX + 1) })),
    );

    await expectRefusal(response);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("returns the streamed-overflow 413 even when cancel never settles", async () => {
    const downstream = vi.fn();
    const cancel = vi.fn(neverSettles);
    const body = new ReadableStream<Uint8Array>(
      {
        cancel,
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );

    const response = await within(
      fixture(downstream).request(streamRequest(body, { "content-length": "1" })),
    );

    await expectRefusal(response);
    expect(cancel).toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("settles the 413 before a late-rejecting cancel and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const downstream = vi.fn();
      let rejectCancel: ((reason: unknown) => void) | undefined;
      const cancel = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCancel = reject;
          }),
      );
      const body = new ReadableStream<Uint8Array>(
        {
          cancel,
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
          },
        },
        { highWaterMark: 0 },
      );

      // The cancel promise is still unsettled here; the refusal must not wait.
      const response = await within(
        fixture(downstream).request(streamRequest(body, { "content-length": "1" })),
      );
      await expectRefusal(response);
      expect(cancel).toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
      expect(rejectCancel, "cancellation must have been initiated").toBeTypeOf("function");

      // The late rejection must be swallowed by whoever initiated the
      // cancellation, not surface as an unhandled rejection afterwards.
      rejectCancel!(new Error("late cancellation failure"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("controls stay intact", () => {
  it("still accepts a body at exactly the advertised cap", async () => {
    const downstream = vi.fn();
    const response = await within(
      fixture(downstream).request("/x", {
        method: "POST",
        headers: { accept: "application/json", "content-length": String(MAX) },
        body: "x".repeat(MAX),
      }),
    );
    expect(response).not.toBe(PENDING);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: MAX });
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("still accepts a streamed body at exactly the cap", async () => {
    const downstream = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX));
        controller.close();
      },
    });
    const response = await within(
      fixture(downstream).request(streamRequest(body, { "content-length": "1" })),
    );
    expect(response).not.toBe(PENDING);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: MAX });
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("still counts UTF-8 bytes: exact byte cap passes, one byte over refuses", async () => {
    const downstream = vi.fn();
    const app = fixture(downstream);
    const exact = "é".repeat(MAX / 2);
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX);
    const ok = await within(
      app.request("/x", {
        method: "POST",
        headers: { accept: "application/json" },
        body: exact,
      }),
    );
    expect(ok).not.toBe(PENDING);
    expect((ok as Response).status).toBe(200);

    const over = await within(
      app.request("/x", {
        method: "POST",
        headers: { accept: "application/json" },
        body: `${exact}x`,
      }),
    );
    await expectRefusal(over);
  });

  it("a source error mid-stream settles without a 413 and without reaching downstream", async () => {
    const downstream = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(new Uint8Array(8));
          else controller.error(new Error("source boom"));
        },
      },
      { highWaterMark: 0 },
    );
    const settled = await within(
      Promise.resolve(
        fixture(downstream).request(streamRequest(body, { "content-length": "1" })),
      ).then(
        (res) => ({ kind: "response" as const, res }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    );
    expect(settled, "source-error handling must settle in finite time").not.toBe(PENDING);
    const outcome = settled as { kind: "response"; res: Response } | { kind: "error" };
    if (outcome.kind === "response") {
      expect(outcome.res.status).not.toBe(200);
      expect(outcome.res.status).not.toBe(413);
    }
    expect(downstream).not.toHaveBeenCalled();
  });
});
