// route-inventory: GET /admin/reconciliation
// route-inventory: GET /admin/reconciliation/:key
import { beforeEach, expect, it, vi } from "vitest";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const { factory } = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../src/admin/reconciliation-service", () => ({ reconciliationServiceFor: factory }));
const service = { listOpen: vi.fn(), listResolved: vi.fn(), get: vi.fn() };
const list = "/admin/reconciliation";
const key = "30000000-0000-0000-0000-000000000001";
const detail = `${list}/${key}`;
const at = new Date("2026-01-01T00:00:00Z");
const row = {
  idempotencyKey: key,
  verb: "event.upsert",
  subject: "event:42",
  firstSeenAt: at,
  lastAttemptAt: at,
  attempts: 1,
  lastCode: null,
  lastStatus: null,
  resolvedAt: null,
  resolution: null,
};

async function fixture(actor: typeof MODERATOR | null = MODERATOR) {
  const store = createMemorySessionStore();
  const cookie = actor ? await cookieFor(store, actor) : "";
  return (path: string) =>
    app.request(
      path,
      { headers: { cookie, accept: "text/html" } },
      { ...env, SESSION_STORE: store },
    );
}

beforeEach(() => {
  vi.resetAllMocks();
  factory.mockResolvedValue(service);
  service.listOpen.mockResolvedValue([]);
  service.listResolved.mockResolvedValue([]);
  service.get.mockResolvedValue(null);
});

it("requires moderators before calling the service", async () => {
  for (const [actor, status] of [
    [null, 302],
    [MEMBER, 403],
  ] as const) {
    const request = await fixture(actor);
    expect((await request(list)).status).toBe(status);
    expect((await request(detail)).status).toBe(status);
  }
  expect(factory).not.toHaveBeenCalled();
});

it("renders the empty list, list and detail without exposing unprojected fields", async () => {
  const request = await fixture();
  expect(await (await request(list)).text()).toContain("No open records found");
  service.listOpen.mockResolvedValueOnce([row]);
  expect(await (await request(list)).text()).toContain(detail);
  service.get.mockResolvedValueOnce({ ...row, diagnostic: "Private diagnostic fixture" });
  const open = await (await request(detail)).text();
  expect(open).toContain("Delivery was not confirmed");
  expect(open).not.toContain("Private diagnostic fixture");
  expect(open).not.toContain(`${detail}/resolve`);
  service.get.mockResolvedValueOnce({ ...row, resolvedAt: at, resolution: "superseded" });
  const resolved = await (await request(detail)).text();
  expect(resolved).toContain("Superseded");
  expect(resolved).toContain("Read-only");
  expect(resolved).not.toContain("Delivery was not confirmed");
  expect(resolved).not.toContain(`${detail}/resolve`);
  expect((await request(detail)).status).toBe(404);
  expect(factory).toHaveBeenCalledWith(expect.anything(), MODERATOR.userId);
  expect(service.get).toHaveBeenCalledWith(key);
});

it("fails closed on unavailable reads without leaking errors or partial lists", async () => {
  const request = await fixture();
  service.listOpen.mockResolvedValueOnce([row]);
  for (const [call, path] of [
    [service.listResolved, list],
    [service.get, detail],
  ] as const) {
    call.mockRejectedValueOnce(new Error("Private receipt failure"));
    const refused = await request(path);
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toMatch(/Private receipt failure|event:42/);
  }
  factory.mockResolvedValueOnce(null);
  expect((await request(list)).status).toBe(503);
});
