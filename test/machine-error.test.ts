import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { withMachineErrors } from "../src/http/machine-error";
import { safeRequestId } from "../src/http/request-log";
import { currentReleaseFields } from "../src/release-tag";
import { parseAlert } from "../tail/worker";

const route = "/api/public/events/:key";
const request = new Request("https://example.test/api/public/events/private-key?query=private");
const requestId = "0123456789abcdef-LHR";
const getRequestId = (event: { requestId?: string }) => event.requestId;

function captureAlert() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("withMachineErrors (public REST)", () => {
  beforeEach(__resetAlertRateLimitForTests);
  afterEach(() => vi.restoreAllMocks());

  it("passes returned successes and deliberate refusals through by identity", async () => {
    const log = captureAlert();
    const success = new Response("ok", { headers: { "cache-control": "public, max-age=60" } });
    const refusal = new Response(null, { status: 404 });
    const event = { request };
    expect(await withMachineErrors(() => success, { route })(event)).toBe(success);
    expect(await withMachineErrors(() => Promise.resolve(refusal), { route })(event)).toBe(refusal);
    expect(log).not.toHaveBeenCalled();
  });

  it("turns a synchronous throw into the REST 500 and a tail-recognized class-only alert", async () => {
    const log = captureAlert();
    const wrapped = withMachineErrors(
      (_event: { request: Request; requestId: string }) => {
        throw new TypeError("private exception message");
      },
      { route, getRequestId },
    );
    const response = await wrapped({ request, requestId });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(await response.json()).toEqual({
      error: {
        code: "internal",
        message: "Event data could not be read.",
        request_id: requestId,
        next: "Retry the read shortly.",
      },
    });

    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] ?? [];
    expect(JSON.parse(line)).toEqual({
      level: "critical",
      event: "error.alert",
      fingerprint: `TypeError@${route}`,
      exception: "TypeError",
      error_class: "TypeError",
      method: "GET",
      route,
      request_id: requestId,
      ...currentReleaseFields(),
    });
    expect(await parseAlert(line, Date.parse("2026-10-01T00:00:00Z"))).toEqual({
      event: "error.alert",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      route,
      timestamp: "2026-10-01T00:00:00.000Z",
    });
  });

  it.each([undefined, "private-id"])(
    "replaces an absent or invalid ID (%s) on rejection",
    async (id) => {
      const log = captureAlert();
      const wrapped = withMachineErrors(
        (_event: { request: Request; requestId?: string }) => Promise.reject("private rejection"),
        { route, getRequestId },
      );
      const response = await wrapped({ request, requestId: id });
      const generated = response.headers.get("x-request-id");
      expect(generated).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(safeRequestId(generated)).toBe(generated);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "internal", request_id: generated },
      });
      expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ route, request_id: generated });
    },
  );

  it("still returns the REST 500 if the thrown value cannot be inspected", async () => {
    const log = captureAlert();
    const wrapped = withMachineErrors(
      () =>
        Promise.reject(
          Object.defineProperty({}, "name", {
            get: () => {
              throw new Error("private accessor message");
            },
          }),
        ),
      { route },
    );
    expect((await wrapped({ request })).status).toBe(500);
    expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ exception: "Error", route });
  });
});
