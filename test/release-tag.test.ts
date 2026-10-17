// Release-tagged structured logs: every http.request / error.alert /
// queue.failing line carries request_id, route/job, error_class and the
// deployed build (build_sha/release), parsed from the Worker Version tag.
// Local fixtures only; no deployed Worker is contacted.
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests, alertQueueFailing } from "../src/alerts";
import type { Env } from "../src/env";
import { registerErrorHandlers } from "../src/errors";
import { createPublicMcpServer } from "../src/mcp/server";
import {
  __resetReleaseForTests,
  buildShaFromTag,
  releaseFields,
  setReleaseMetadata,
} from "../src/release-tag";
import { requestLog } from "../src/request-log";
import { revisionReadiness } from "../src/up-revision";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RAY = "0123456789abcdef-LHR";

afterEach(() => {
  vi.restoreAllMocks();
  __resetAlertRateLimitForTests();
  __resetReleaseForTests();
});

describe("version tag parsing", () => {
  it("accepts the staging bare-SHA tag and the production composite tag", () => {
    expect(buildShaFromTag(SHA)).toBe(SHA);
    expect(buildShaFromTag(`${SHA}-123456789-2`)).toBe(SHA);
    expect(releaseFields({ tag: `${SHA}-123456789-2` })).toEqual({
      build_sha: SHA,
      release: SHA,
    });
  });

  it.each([
    "manual-deploy",
    SHA.toUpperCase(),
    SHA.slice(0, 39),
    `${SHA}-run-attempt`,
    `${SHA} `,
    "bearer-secret-value-that-must-never-be-logged",
    42,
    null,
    undefined,
  ])("rejects %j instead of logging it", (tag) => {
    expect(buildShaFromTag(tag)).toBeNull();
    expect(releaseFields({ tag })).toEqual({ build_sha: null, release: null });
  });

  it("leaves both fields null when the binding is absent", () => {
    expect(releaseFields(undefined)).toEqual({ build_sha: null, release: null });
    expect(releaseFields(null)).toEqual({ build_sha: null, release: null });
  });

  it("gives /up the commit from a production composite tag", () => {
    expect(revisionReadiness({ id: "version-1", tag: `${SHA}-123456789-2` })).toEqual({
      revision: { version_id: "version-1", commit: SHA },
    });
    expect(revisionReadiness({ id: "version-1", tag: "manual-deploy" })).toEqual({
      revision: { version_id: "version-1", commit: null },
    });
  });
});

function fixtureApp() {
  const router = new Hono<{ Bindings: Env }>();
  router.use("*", requestLog);
  registerErrorHandlers(router);
  router.get("/ok/:id", (c) => c.text("ok"));
  router.get("/boom/:id", () => {
    throw new TypeError("private failure with a bearer-secret");
  });
  return router;
}

const taggedEnv = {
  APP_URL: "https://example.test",
  SESSION_SECRET: "fixture-only",
  CF_VERSION_METADATA: { id: "version-1", tag: SHA },
} as Env;

function jsonLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
    .filter(Boolean);
}

describe("release fields on structured log lines", () => {
  it("tags http.request with the deployed SHA and a null error_class", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await fixtureApp().request(
      "/ok/private-id",
      { headers: { "cf-ray": RAY } },
      taggedEnv,
    );
    expect(res.status).toBe(200);
    expect(jsonLines(log)).toEqual([
      expect.objectContaining({
        event: "http.request",
        request_id: RAY,
        route: "/ok/:id",
        error_class: null,
        build_sha: SHA,
        release: SHA,
      }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-id");
  });

  it("correlates error.alert with http.request by request_id and build, class only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fixtureApp().request(
      "/boom/private-id",
      { headers: { "cf-ray": RAY } },
      taggedEnv,
    );
    expect(res.status).toBe(500);
    const alerts = jsonLines(error).filter((l) => l.event === "error.alert");
    expect(alerts).toEqual([
      expect.objectContaining({
        event: "error.alert",
        request_id: RAY,
        route: "/boom/:id",
        exception: "TypeError",
        error_class: "TypeError",
        build_sha: SHA,
        release: SHA,
      }),
    ]);
    expect(jsonLines(log)[0]).toMatchObject({ request_id: RAY, build_sha: SHA });
    for (const secret of ["bearer-secret", "private-id", "private failure"])
      expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(secret);
  });

  it("tags queue.failing with job, error_class, request_id and build", () => {
    setReleaseMetadata({ tag: `${SHA}-123456789-2` });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    alertQueueFailing({
      connection: "cloudflare-queues",
      queue: "two-sync-event",
      job: "SyncEventToDiscord",
      attempts: 3,
      exception: "BotTerminalError",
      requestId: RAY,
    });
    expect(jsonLines(error)).toEqual([
      expect.objectContaining({
        event: "queue.failing",
        job: "SyncEventToDiscord",
        exception: "BotTerminalError",
        error_class: "BotTerminalError",
        request_id: RAY,
        build_sha: SHA,
        release: SHA,
      }),
    ]);
  });

  it("never echoes an unparsable version tag into a log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = {
      ...taggedEnv,
      CF_VERSION_METADATA: { id: "v", tag: "bearer-secret-manual-tag" },
    } as Env;
    await fixtureApp().request("/ok/x", { headers: { "cf-ray": RAY } }, env);
    expect(jsonLines(log)[0]).toMatchObject({ build_sha: null, release: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain("bearer-secret");
  });
});

describe("/mcp tool errors correlate with the HTTP request", () => {
  it("alerts with the request ID instead of dropping it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // get_join reads only env config; a throwing getter drives the tool's
    // internal-error path without a database.
    const env = { APP_URL: "https://example.test" } as Env;
    Object.defineProperty(env, "DISCORD_INVITE_URL", {
      get() {
        throw new TypeError("invite lookup bearer-secret");
      },
    });
    const server = createPublicMcpServer({ env, db: null, requestId: RAY });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const replies: Record<string, unknown>[] = [];
    clientTransport.onmessage = (message) => void replies.push(message as never);
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_join", arguments: {} },
    });
    await vi.waitFor(() => expect(replies.some((r) => r.id === 2)).toBe(true));
    const alerts = jsonLines(error).filter((l) => l.event === "error.alert");
    expect(alerts).toEqual([
      expect.objectContaining({
        event: "error.alert",
        route: "/mcp",
        request_id: RAY,
        error_class: "TypeError",
      }),
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toContain("bearer-secret");
    await server.close();
    await clientTransport.close();
  });
});
