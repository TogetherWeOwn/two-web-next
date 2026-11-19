import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeKitReconciliation } from "../src/admin/kit-reconciliation-write";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { env, MEMBER, MODERATOR } from "./helpers/member-data";

const { factory, throttle } = vi.hoisted(() => ({ factory: vi.fn(), throttle: vi.fn() }));
vi.mock("../src/admin/reconciliation-service", () => ({ reconciliationServiceFor: factory }));
vi.mock("../src/throttle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/throttle")>()),
  throttleGuard: throttle,
}));
const resolve = vi.fn();
const key = "30000000-0000-0000-0000-000000000001";
const moderator = { status: "authenticated", session: { ...MODERATOR, avatar: null } } as const;
const form = "resolution=confirmed";

function post(body = form, locals: Parameters<typeof writeKitReconciliation>[2] = moderator) {
  const request = new Request(`${env.APP_URL}/admin/reconciliation/${key}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return writeKitReconciliation(request, key, locals, env);
}

beforeEach(() => {
  vi.resetAllMocks();
  throttle.mockResolvedValue(null);
  factory.mockResolvedValue({ resolve });
  resolve.mockResolvedValue("resolved");
});
afterEach(() => vi.restoreAllMocks());

it("requires a moderator before reading the upload, throttling or resolving", async () => {
  expect(await post(form, { status: "guest", session: null })).toEqual({ status: 401 });
  expect(
    await post(form, { status: "authenticated", session: { ...MEMBER, avatar: null } }),
  ).toEqual({
    status: 403,
  });
  expect(await post(form, { status: "unknown", session: null })).toEqual({ status: 503 });
  expect(throttle).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
});

it("rejects over-cap and invalid bodies without resolving", async () => {
  expect(await post("x".repeat(BODY_LIMIT_BYTES.action + 1))).toEqual({ status: 413 });
  expect(throttle).not.toHaveBeenCalled();
  for (const body of ["", `${form}&${form}`, `${form}&note=extra`, "resolution=other"]) {
    expect(await post(body)).toEqual({ status: 400 });
  }
  expect(factory).not.toHaveBeenCalled();
});

it("accepts a valid form at exactly the action cap", async () => {
  const body = form.padEnd(BODY_LIMIT_BYTES.action, "&");
  expect(await post(body)).toEqual({ status: 303 });
  expect(resolve).toHaveBeenCalledExactlyOnceWith(key, "confirmed");
});

it("spends the shared admin-write budget before calling the audited service", async () => {
  throttle.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { "retry-after": "5" } }),
  );
  expect(await post()).toEqual({ status: 429, retryAfter: "5" });
  expect(throttle).toHaveBeenCalledWith(expect.anything(), "admin-write", 30);
  expect(factory).not.toHaveBeenCalled();
  expect(await post()).toEqual({ status: 303 });
  expect(factory).toHaveBeenCalledWith(env, MODERATOR.userId);
  expect(resolve).toHaveBeenCalledWith(key, "confirmed");
  resolve.mockResolvedValueOnce("unchanged");
  expect(await post()).toEqual({ status: 409 });
});

it("fails closed with a static alert on receipt failure", async () => {
  __resetAlertRateLimitForTests();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  factory.mockResolvedValueOnce(null);
  expect(await post()).toEqual({ status: 503 });
  resolve.mockRejectedValueOnce(new Error("private receipt failure"));
  expect(await post()).toEqual({ status: 503 });
  const line = log.mock.calls[0]?.[0] as string;
  expect(JSON.parse(line)).toMatchObject({ method: "POST", route: "/admin/reconciliation/:key" });
  expect(line).not.toContain("private receipt failure");
  expect(line).not.toContain(key);
});
