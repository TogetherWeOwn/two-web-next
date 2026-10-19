// route-inventory: POST /__probe/alert
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { env as baseEnv } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

const token = "test-only-probe-token";
const staging = { ...baseEnv, APP_URL: STAGING_APP_URL, QA_AUTH_TOKEN: token };
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
afterEach(() => vi.restoreAllMocks());

function overCap(advertised: boolean, headers: Record<string, string> = {}) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL("/__probe/alert", STAGING_APP_URL).toString(), {
    method: "POST",
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: new URL(STAGING_APP_URL).origin,
      accept: "application/json",
      [QA_HEADER]: token,
      ...headers,
      ...(advertised ? { "content-length": String(BODY_LIMIT_BYTES.action + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

describe("alert probe body cap runs before the throttle", () => {
  it.each([false, true])(
    "refuses over-cap bodies with 413 and zero throttle spend (advertised: %s)",
    async (advertised) => {
      const store = vi.fn(async () => null);
      const send = vi.fn();
      const { request, pull } = overCap(advertised);
      const response = await app.request(request, undefined, {
        ...staging,
        THROTTLE_STORE: store,
        INTERNAL_ACTION_QUEUE: { send } as unknown as Queue,
      } as Env);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      if (advertised) expect(pull).not.toHaveBeenCalled();
      else expect(pull.mock.calls.length).toBeLessThanOrEqual(BODY_LIMIT_BYTES.action / 1024 + 2);
      expect(store).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    },
  );

  it("still throttles under-cap probes against a spent bucket", async () => {
    const store = vi.fn(async () => withThrottleTx((async () => [{ n: 10, wait: 30 }]) as never));
    const send = vi.fn();
    const response = await app.request(
      new URL("/__probe/alert", STAGING_APP_URL).toString(),
      {
        method: "POST",
        body: "{}",
        headers: { origin: new URL(STAGING_APP_URL).origin, [QA_HEADER]: token },
      },
      { ...staging, THROTTLE_STORE: store, INTERNAL_ACTION_QUEUE: { send } } as unknown as Env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(store).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("still reaches the 500 receipt path for admitted under-cap probes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = vi.fn(async () => null);
    const send = vi.fn(async () => {});
    const response = await app.request(
      new URL("/__probe/alert", STAGING_APP_URL).toString(),
      {
        method: "POST",
        body: "{}",
        headers: { origin: new URL(STAGING_APP_URL).origin, [QA_HEADER]: token },
      },
      { ...staging, THROTTLE_STORE: store, INTERNAL_ACTION_QUEUE: { send } } as unknown as Env,
    );
    expect(response.status).toBe(500);
    expect(send).toHaveBeenCalledOnce();
  });

  it("still 404s bad-token over-cap bodies at the QA gate without throttle spend", async () => {
    const store = vi.fn(async () => null);
    const send = vi.fn();
    for (const advertised of [false, true]) {
      const { request, pull } = overCap(advertised, { [QA_HEADER]: "wrong" });
      const response = await app.request(request, undefined, {
        ...staging,
        THROTTLE_STORE: store,
        INTERNAL_ACTION_QUEUE: { send } as unknown as Queue,
      } as Env);
      expect(response.status).toBe(404);
      expect(pull).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    }
    expect(store).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
