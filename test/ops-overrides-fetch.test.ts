import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchOpsOverrides } from "../src/admin/ops-overrides-fetch";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

const control = "synthetic-control-bearer".padEnd(32, "x");
const evidence = "synthetic-evidence-bearer".padEnd(32, "x");
const qa = "synthetic-qa-bearer".padEnd(32, "x");
const bearer = `Bearer ${control}`;
const record = { epoch: 7, overrides: { SETTING: "<example>" }, baseline: {}, enforcement: "off" };
const refusedMethods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const bot = vi.fn<typeof fetch>();
let client = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  bot.mockReset().mockImplementation(async () => Response.json(record));
  vi.stubGlobal("fetch", bot);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function request(ip: string, method: string, authorization: string, query = "", cookie?: string) {
  return new Request(`${env.APP_URL}/admin/ops-overrides${query}`, {
    method,
    headers: {
      authorization,
      ...(cookie === undefined ? {} : { cookie }),
      origin: env.APP_URL,
      accept: "text/html",
      "cf-connecting-ip": ip,
    },
  });
}

async function fixture({ configured = control, withModerator = false } = {}) {
  const sessions = createMemorySessionStore();
  const cookie = withModerator ? await cookieFor(sessions, MODERATOR) : undefined;
  const get = vi.spyOn(sessions, "get");
  const bindings = {
    ...env,
    OPS_CONTROL_TOKEN: configured || undefined,
    SOURCE_EVIDENCE_VERIFIER_TOKEN: evidence,
    QA_AUTH_TOKEN: qa,
    SESSION_STORE: sessions,
    BOT_ENDPOINT_URL: "https://bot.example.test/internal-action",
  };
  // The adapter reuses the shipped per-isolate bucket. Give each side its own
  // synthetic client so running the oracle cannot consume the adapter's budget.
  const honoClient = `192.0.2.${++client}`;
  const fetchClient = `192.0.2.${++client}`;
  return async (status: number, method = "GET", authorization = bearer, query = "") => {
    const legacy = await app.request(
      request(honoClient, method, authorization, query, cookie),
      undefined,
      bindings,
    );
    const adapted = await fetchOpsOverrides(
      request(fetchClient, method, authorization, query, cookie),
      bindings,
    );
    if (!adapted) throw new Error("adapter did not handle a shipped method");
    expect(adapted.status).toBe(status);
    expect(adapted.status).toBe(legacy.status);
    expect(adapted.headers.get("cache-control")).toBe("private, no-store");
    for (const header of [
      "cache-control",
      "content-length",
      "content-type",
      "location",
      "www-authenticate",
      "retry-after",
      "allow",
      "set-cookie",
    ]) {
      expect(adapted.headers.get(header), header).toBe(legacy.headers.get(header));
    }
    expect(adapted.headers.has("location")).toBe(false);
    expect(adapted.headers.has("set-cookie")).toBe(false);
    expect(get).not.toHaveBeenCalled();
    if (method === "GET" || method === "HEAD") {
      expect(adapted.headers.get("referrer-policy")).toBe("no-referrer");
    }
    const body = await adapted.text();
    expect(body).toBe(await legacy.text());
    if (method === "HEAD") expect(adapted.body).toBeNull();
    return { body, headers: adapted.headers };
  };
}

it.each(["", `Bearer ${evidence}`, `Bearer ${qa}`, "Bearer wrong", `bearer ${control}`])(
  "denies a moderator cookie without an exact control bearer (%j)",
  async (authorization) => {
    const compare = await fixture({ withModerator: true });
    const { headers } = await compare(401, "GET", authorization);
    expect(headers.get("www-authenticate")).toBe("Bearer");
    await compare(401, "HEAD", authorization);
    expect(bot).not.toHaveBeenCalled();
  },
);

it("stays dark without configuration and rejects even a bare query before contacting the bot", async () => {
  await (await fixture({ configured: "" }))(404, "GET", bearer, "?token=synthetic");
  const compare = await fixture();
  await compare(400, "GET", bearer, "?");
  await compare(400, "GET", "", "?token=synthetic");
  expect(bot).not.toHaveBeenCalled();
});

it.each([
  { label: "with only the bearer", withModerator: false },
  { label: "without forwarding an accompanying moderator cookie", withModerator: true },
])("returns the bounded snapshot for GET and bodyless HEAD $label", async ({ withModerator }) => {
  const compare = await fixture({ withModerator });
  expect((await compare(200)).body).toContain("&lt;example&gt;");
  await compare(200, "HEAD");
  expect(bot).toHaveBeenCalledTimes(4);
  for (const args of bot.mock.calls) {
    const outbound = new Request(...args);
    expect(outbound.url).toBe("https://bot.example.test/ops/config");
    expect(outbound.method).toBe("GET");
    expect(outbound.redirect).toBe("manual");
    expect(outbound.headers.get("authorization")).toBe(bearer);
    expect(outbound.headers.has("cookie")).toBe(false);
  }
});

it("returns sanitized unavailability without retrying an oversized bot response", async () => {
  bot.mockImplementation(async () =>
    Response.json({
      ...record,
      enforcement: "synthetic upstream detail",
      padding: "x".repeat(256 * 1024),
    }),
  );
  const { body } = await (await fixture())(503);
  expect(body).toContain("Operator record unavailable");
  expect(body).not.toContain("synthetic upstream detail");
  expect(bot).toHaveBeenCalledTimes(2);
});

it("preserves the attempt bucket across GET and HEAD, including refill and refund", async () => {
  const compare = await fixture();
  for (let attempt = 0; attempt < 10; attempt++) await compare(401, "GET", "Bearer wrong");
  expect((await compare(429, "HEAD")).headers.get("retry-after")).toBe("1");
  expect(bot).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 1000);
  await compare(200, "HEAD");
  await compare(200);
  expect(bot).toHaveBeenCalledTimes(4);
});

it("shares one attempt budget with the mounted route for the same client", async () => {
  const ip = `192.0.2.${++client}`;
  const bindings = { ...env, OPS_CONTROL_TOKEN: control };
  for (let attempt = 0; attempt < 10; attempt++) {
    const legacy = await app.request(request(ip, "GET", "Bearer wrong"), undefined, bindings);
    expect(legacy.status).toBe(401);
  }
  const adapted = await fetchOpsOverrides(request(ip, "HEAD", bearer), bindings);
  expect(adapted?.status).toBe(429);
  expect(adapted?.headers.get("retry-after")).toBe("1");
  expect(bot).not.toHaveBeenCalled();
});

it.each(refusedMethods)("refuses %s before admission with fixed JSON and Allow", async (method) => {
  const { headers, body } = await (await fixture({ configured: "" }))(
    405,
    method,
    "",
    "?token=synthetic",
  );
  expect(headers.get("allow")).toBe("GET, HEAD");
  expect(body).toBe('{"error":"method_not_allowed"}');
  expect(bot).not.toHaveBeenCalled();
});

it.each(refusedMethods)("rejects oversized %s bodies before the fixed refusal", async (method) => {
  const body = "x".repeat(BODY_LIMIT_BYTES.action + 1);
  for (const advertised of [true, false]) {
    const oversized = () => {
      const input = new Request(request("192.0.2.254", method, ""), { body });
      if (advertised) input.headers.set("content-length", String(body.length));
      return input;
    };
    const legacy = await app.request(oversized(), undefined, env);
    const adapted = await fetchOpsOverrides(oversized(), env);
    expect(legacy.status, `advertised=${advertised}`).toBe(413);
    expect(adapted?.status, `advertised=${advertised}`).toBe(legacy.status);
    expect(adapted?.headers.get("cache-control")).toBe(legacy.headers.get("cache-control"));
    expect(adapted?.headers.get("content-type")).toBe(legacy.headers.get("content-type"));
    expect(adapted?.headers.has("allow")).toBe(false);
  }
  expect(bot).not.toHaveBeenCalled();
});

it("leaves other verbs to the caller's fallback instead of extending the fixed 405", async () => {
  const request = new Request(`${env.APP_URL}/admin/ops-overrides`, { method: "PROPFIND" });
  expect(await fetchOpsOverrides(request, env)).toBeNull();
  expect(bot).not.toHaveBeenCalled();
});
