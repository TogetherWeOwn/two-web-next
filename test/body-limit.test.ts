import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { BODY_LIMIT_BYTES, bodyLimitClass, requestBodyLimit, type BodyClass } from "../src/body-limit";
import app from "../src/index";
import { cspReportsRoute, MAX_CSP_REPORT_BYTES } from "../src/csp-reports";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { serializeSigned } from "hono/utils/cookie";

const ERROR = { reason: "payload_too_large", message: "Reduce the size of your request and try again." };
const encoder = new TextEncoder();

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const writeRoutes = new Map<string, BodyClass | undefined>();
for (const route of app.routes.filter((r) => MUTATING.has(r.method))) {
  const key = `${route.method} ${route.path}`;
  writeRoutes.set(key, bodyLimitClass(route.handler) ?? writeRoutes.get(key));
}

// One deliberate exemption: CSP already counts/cancels at 8 KiB and quietly
// drops oversized reports (204) to avoid browser retry amplification.
const CSP_ROUTE = "POST /csp-reports";

describe("every registered write route is body-limited", () => {
  it("has a route limiter everywhere except the already-capped CSP sink", () => {
    expect(writeRoutes.size).toBeGreaterThan(10);
    expect([...writeRoutes].filter(([key, kind]) => !kind && key !== CSP_ROUTE)).toEqual([]);
    expect(app.routes.some((r) => `${r.method} ${r.path}` === CSP_ROUTE && r.handler === cspReportsRoute)).toBe(true);
    expect(MAX_CSP_REPORT_BYTES).toBe(8192);
    // ALL handlers must not become a back door for a new write endpoint.
    const allPaths = [...new Set(app.routes.filter((r) => r.method === "ALL").map((r) => r.path))];
    expect(allPaths.sort()).toEqual(["/*", "/admin/*", "/events/:key/rsvp", "/members/*", "/profile"].sort());
  });

  it.each([...writeRoutes].filter((entry): entry is [string, BodyClass] => entry[1] !== undefined))(
    "%s accepts its cap and refuses cap+1 before parsing or writing",
    async (key, kind) => {
      const [method, pattern] = key.split(" ");
      const path = pattern!.replace(":key", "test-event").replace(":user", "111111111111111111").replace(":id", "1").replace(":identity", "test");
      const max = BODY_LIMIT_BYTES[kind];
      for (const bytes of [max, max + 1]) {
        const store = createMemorySessionStore();
        const token = newSessionToken();
        await store.create({
          tokenHash: await hashToken(token), userId: "111111111111111111", username: "mod", avatar: null,
          member: true, moderator: true, expiresAt: new Date(Date.now() + 3600_000),
        });
        const env = {
          APP_URL: "https://next.example.test", SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
          SESSION_STORE: store,
        } as unknown as Env;
        const cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true })).split(";")[0]!;
        const response = await app.request(path, {
          method, body: "x".repeat(bytes), headers: { cookie, accept: "application/json", "content-type": "application/json" },
        }, env);
        if (bytes === max) expect(response.status).not.toBe(413);
        else {
          expect(response.status).toBe(413);
          expect(await response.json()).toEqual(ERROR);
        }
      }
    },
  );
});

describe("parser and error compatibility", () => {
  it("preserves raw JSON bytes and advertised length after counting", async () => {
    const api = new Hono<{ Bindings: Env }>();
    api.post("/x", requestBodyLimit("agent"), async (c) => c.json({ text: await c.req.text(), length: c.req.header("content-length") }));
    const body = '{ "description": "Unicode 😀", "op": "create" }';
    const length = String(encoder.encode(body).byteLength);
    const response = await api.request("/x", { method: "POST", body, headers: { "content-length": length } });
    expect(await response.json()).toEqual({ text: body, length });
  });

  it.each([false, true])("keeps form parsing and duplicate trap values intact (multipart: %s)", async (multipart) => {
    const form = new Hono<{ Bindings: Env }>();
    form.post("/x", requestBodyLimit("form"), async (c) => c.json(await c.req.parseBody({ all: true })));
    const body = multipart ? new FormData() : new URLSearchParams();
    body.append("bio", "😀 bio");
    body.append("website", "");
    body.append("website", "filled");
    const response = await form.request("/x", { method: "POST", body });
    expect(await response.json()).toEqual({ bio: "😀 bio", website: ["", "filled"] });
  });

  it("uses the static branded error for browsers and JSON for API paths", async () => {
    const api = new Hono<{ Bindings: Env }>();
    api.post("/api/x", requestBodyLimit("action"), (c) => c.body(null, 204));
    const body = "private-request-marker".repeat(300);
    const json = await api.request("/api/x", { method: "POST", body });
    expect(json.status).toBe(413);
    expect(await json.json()).toEqual(ERROR);
    const html = await fixture("action").request("/x", { method: "POST", body, headers: { accept: "text/html" } });
    expect(html.status).toBe(413);
    const page = await html.text();
    expect(page).toContain("That request is too large");
    expect(page).not.toMatch(/private-request-marker|stack|PayloadTooLargeError|4096/);
  });

  it("refuses an advertised overflow without reading the upload", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const response = await fixture("action").request(new Request("http://localhost/x", {
      method: "POST", body, duplex: "half", headers: { "content-length": String(BODY_LIMIT_BYTES.action + 1) },
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function fixture(kind: keyof typeof BODY_LIMIT_BYTES) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/x", requestBodyLimit(kind), async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  return app;
}

for (const kind of Object.keys(BODY_LIMIT_BYTES) as (keyof typeof BODY_LIMIT_BYTES)[]) {
  describe(`${kind} body boundary`, () => {
    const max = BODY_LIMIT_BYTES[kind];
    const app = fixture(kind);

    it.each([false, true])("accepts exactly the cap (content-length: %s)", async (advertise) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (advertise) headers["content-length"] = String(max);
      const response = await app.request("/x", { method: "POST", headers, body: "x".repeat(max) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ bytes: max });
    });

    it.each([undefined, "1", String(max + 1), "not-a-number"])("rejects cap+1 with content-length %s", async (length) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (length !== undefined) headers["content-length"] = length;
      const response = await app.request("/x", { method: "POST", headers, body: "x".repeat(max + 1) });
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(await response.json()).toEqual(ERROR);
    });

    it("counts UTF-8 bytes, not characters", async () => {
      const body = "é".repeat(max / 2) + "x";
      expect(encoder.encode(body).byteLength).toBe(max + 1);
      expect((await app.request("/x", { method: "POST", body })).status).toBe(413);
    });

    it("stops an unbounded chunked body at the first overflow chunk", async () => {
      let pulls = 0;
      const cancel = vi.fn();
      const body = new ReadableStream({
        cancel,
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024));
        },
      }, { highWaterMark: 0 });
      const response = await app.request(new Request("http://localhost/x", {
        method: "POST", body, duplex: "half", headers: { "content-length": "1", accept: "application/json" },
      } as RequestInit));
      expect(response.status).toBe(413);
      // Request construction can prefetch one chunk on Node's stream proxy.
      expect(pulls).toBeLessThanOrEqual(max / 1024 + 2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(await response.json()).toEqual(ERROR);
    });
  });
}
