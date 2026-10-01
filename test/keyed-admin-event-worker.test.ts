import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Actual mounted handlers, roles and Drizzle observation in workerd. Adapter
// execution/storage is memory, NOT a Postgres INSERT/persistence proof. The
// corresponding real-row/failed-INSERT proofs are admin-keyed-mounted and
// event-attendees; unsupported producer pulls are keyed-member-worker.
describe("keyed admin/event handlers in workerd", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const bundle = await build({ entryPoints: ["test/fixtures/keyed-admin-event-worker.ts"], bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles![0]!.text,
      compatibilityDate: "2026-09-29", compatibilityFlags: ["nodejs_compat"],
      outboundService: async () => { throw new Error("External network forbidden in admin/event fixture"); },
    }));
    await mf.ready;
  }, 30_000);
  afterAll(() => mf?.dispose());
  const request = (surface: string, mode: string) => mf.dispatchFetch(`https://runtime.test/fixture/${surface}/${mode}`, { redirect: "manual" });
  const entries = (res: { headers: { get: (name: string) => string | null } }) => JSON.parse(res.headers.get("x-fixture-audit")!);

  it.each(["roster", "joins", "form"])("%s preserves guest/non-moderator gates without exposing contents", async (surface) => {
    for (const [mode, status] of [["guest", 302], ["non-member", 403], ["member", 403]] as const) {
      const res = await request(surface, mode);
      expect(res.status).toBe(status);
      const body = await res.text();
      expect(body).not.toContain("workerd-attendee-sensitive");
      expect(body).not.toContain("workerd-join-sensitive");
      expect(entries(res)).toEqual([]);
    }
  });
  it.each(["guest", "non-member"])("event %s sees public counts but no attendee identities", async (mode) => {
    const res = await request("event", mode);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("1 going");
    expect(body).not.toContain("workerd-attendee-sensitive");
    expect(entries(res)).toEqual([]);
  });
  it.each([
    ["event", "member", "member", "list", "events.page"], ["event", "moderator", "member", "list", "events.page"],
    ["roster", "moderator", "events", "view", "admin.events.edit"], ["joins", "moderator", "join_attempts", "list", "admin.join-attempts.index"],
  ])("%s %s records one actual-owner entry before buffered HTML", async (surface, mode, resource, action, route) => {
    const res = await request(surface!, mode!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain(surface === "joins" ? "workerd-join-sensitive" : "workerd-attendee-sensitive");
    expect(entries(res)).toEqual([["100000000000000102", "100000000000000102", resource, action, '["100000000000000101"]', 1, route]]);
  });
  it.each(["event", "roster", "joins"])("%s rejects invalid/partial owners and a memory audit refusal", async (surface) => {
    for (const mode of ["invalid", "partial", "audit-failure"]) {
      const res = await request(surface, mode);
      expect(res.status, `${surface}/${mode}`).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.text();
      for (const token of ["workerd-attendee-sensitive", "workerd-join-sensitive", "100000000000000101", "memory audit"]) expect(body).not.toContain(token);
      expect(entries(res)).toEqual([]);
    }
  });
  it.each(["event", "roster", "joins"])("%s self-only/empty sets create no receipt and remain isolated", async (surface) => {
    const responses = await Promise.all([request(surface, "self"), request(surface, "empty")]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(entries(res)).toEqual([]);
    }
    const subsequent = await request(surface, "moderator");
    expect(subsequent.status).toBe(200);
    expect(entries(subsequent)).toHaveLength(1);
  });
  it("an explicitly non-sensitive admin form has no member-key row", async () => {
    const res = await request("form", "moderator");
    expect(res.status).toBe(200);
    expect(entries(res)).toEqual([]);
  });
});
