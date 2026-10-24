// Acceptance contract for the Kit join-attempt detail page
// (GET /admin/join-attempts/:id): valid / missing / invalid ids, moderator
// admission, audited release and audit refusal, escaped trace values, and a
// no-JavaScript page. These tests are failing-first for the Kit port: on a
// tree without the port the read model and route files do not exist and the
// shipped manifest carries no detail entry, so every section is red; the
// port makes them green without editing this file. Hermetic throughout —
// fake reads and the framework-free hook boundary, never a real database.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../src/member-reads";
import {
  decideRoute,
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  type OwnedRoute,
  ROUTE_MANIFEST,
} from "../src/route-ownership";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

type DetailModule = typeof import("../src/admin/kit-join-attempt-detail");
const loadDetailModule = (): Promise<DetailModule> =>
  import("../src/admin/kit-join-attempt-detail");

const ROW = {
  id: 7,
  outcome: "added",
  source: "join",
  requestId: "detail-request",
  discordId: "100000000000000201",
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
};

describe("acceptance: join-attempt detail read model", () => {
  it("valid id returns exactly the six safe fields with a UTC ISO instant", async () => {
    const { resolveKitJoinAttemptDetail } = await loadDetailModule();
    const outcome = await resolveKitJoinAttemptDetail("7", {
      db: {} as never,
      get: async () => ({ attempt: ROW }),
    });
    expect(outcome).toEqual({
      kind: "ok",
      view: {
        id: 7,
        outcome: "added",
        source: "join",
        requestId: "detail-request",
        discordId: "100000000000000201",
        createdAt: "2026-10-01T12:00:00.000Z",
      },
    });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    // No raw provider/token payload rides along: the view is the projection.
    expect(Object.keys(outcome.view).sort()).toEqual([
      "createdAt",
      "discordId",
      "id",
      "outcome",
      "requestId",
      "source",
    ]);
  });

  it("valid bigserial id above the 32-bit cap is admitted", async () => {
    const { parseJoinAttemptId, resolveKitJoinAttemptDetail } = await loadDetailModule();
    expect(parseJoinAttemptId("3000000000")).toBe(3000000000);
    const get = vi.fn(async () => ({ attempt: { ...ROW, id: 3000000000 } }));
    const outcome = await resolveKitJoinAttemptDetail("3000000000", { db: {} as never, get });
    expect(get).toHaveBeenCalledWith(expect.anything(), 3000000000);
    expect(outcome.kind).toBe("ok");
  });

  it("missing or retention-expired id answers notFound", async () => {
    const { resolveKitJoinAttemptDetail } = await loadDetailModule();
    await expect(
      resolveKitJoinAttemptDetail("7", { db: {} as never, get: async () => null }),
    ).resolves.toEqual({ kind: "notFound" });
  });

  it.each([
    "0",
    "-1",
    "+7",
    "01",
    "007",
    "1.0",
    "1e2",
    "abc",
    "7a",
    "",
    " 7",
    "7 ",
    "9007199254740993",
  ])("invalid id %j answers notFound before any record lookup", async (raw) => {
    const { parseJoinAttemptId, resolveKitJoinAttemptDetail } = await loadDetailModule();
    expect(parseJoinAttemptId(raw)).toBeNull();
    const get = vi.fn(async () => ({ attempt: ROW }));
    await expect(resolveKitJoinAttemptDetail(raw, { db: {} as never, get })).resolves.toEqual({
      kind: "notFound",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("no database answers unavailable; a classified outage answers unavailable; other failures propagate", async () => {
    const { resolveKitJoinAttemptDetail } = await loadDetailModule();
    const get = vi.fn(async () => ({ attempt: ROW }));
    await expect(resolveKitJoinAttemptDetail("7", { db: null, get })).resolves.toEqual({
      kind: "unavailable",
    });
    expect(get).not.toHaveBeenCalled();
    const outage = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "57P01",
    });
    await expect(
      resolveKitJoinAttemptDetail("7", {
        db: {} as never,
        get: async () => Promise.reject(outage),
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    // Unclassified failures are not disguised as data: they propagate so the
    // member-read boundary can refuse the response without releasing trace.
    const boom = new Error("boom");
    await expect(
      resolveKitJoinAttemptDetail("7", {
        db: {} as never,
        get: async () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });

  it("missing trace fields stay null for the em-dash fallbacks", async () => {
    const { resolveKitJoinAttemptDetail } = await loadDetailModule();
    const outcome = await resolveKitJoinAttemptDetail("7", {
      db: {} as never,
      get: async () => ({
        attempt: { ...ROW, source: null, requestId: null, discordId: null },
      }),
    });
    expect(outcome).toEqual({
      kind: "ok",
      view: {
        id: 7,
        outcome: "added",
        source: null,
        requestId: null,
        discordId: null,
        createdAt: "2026-10-01T12:00:00.000Z",
      },
    });
  });

  it("adversarial trace values pass through as data, unmangled and not pre-escaped", async () => {
    const { resolveKitJoinAttemptDetail } = await loadDetailModule();
    const hostile = '<script>alert("x")</script>&"\'';
    const outcome = await resolveKitJoinAttemptDetail("7", {
      db: {} as never,
      get: async () => ({ attempt: { ...ROW, requestId: hostile, discordId: hostile } }),
    });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    // The read model must neither strip nor entity-escape: the renderer's
    // text interpolation (pinned below) is the single escaping layer.
    expect(outcome.view.requestId).toBe(hostile);
    expect(outcome.view.discordId).toBe(hostile);
    expect(outcome.view.requestId).not.toContain("&lt;");
  });
});

describe("acceptance: detail route classification and audited release", () => {
  const APP_URL = "https://next.example.test";
  const VIEWER = "100000000000000101";
  const SUBJECT = "100000000000000201";
  const REFUSAL = "Member data is temporarily unavailable.";

  const detailEntry = (): OwnedRoute => {
    const entry = ROUTE_MANIFEST.find((r) => r.path === "/admin/join-attempts/:id");
    expect(entry, "shipped manifest must register the join-attempt detail route").toBeDefined();
    return entry!;
  };

  it("ships enabled as a join_attempts view member read, so Kit serves it", () => {
    const entry = detailEntry();
    expect(entry).toEqual({
      method: "GET",
      path: "/admin/join-attempts/:id",
      enabled: true,
      reads: { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" },
    });
    // Enabled means the hook dispatches the request to Kit inside the
    // member-read boundary; returning the entry to enabled: false hands it
    // back to Hono as the rollback.
    expect(
      decideRoute(new Request(new URL("/admin/join-attempts/7", APP_URL)), ROUTE_MANIFEST),
    ).toBe(entry);
    expect(
      decideRoute(new Request(new URL("/admin/join-attempts/7", APP_URL)), [
        { ...entry, enabled: false },
      ]),
    ).toBeUndefined();
  });

  const authenticated = (userId: string): KitLocals => ({
    status: "authenticated",
    session: { userId, username: "Mod", avatar: null, member: true, moderator: true },
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  });
  const guest = (): KitLocals => ({
    status: "guest",
    session: null,
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  });
  const eventFor = (path: string): HookEventLike => {
    const request = new Request(new URL(path, APP_URL).href, {
      headers: { host: "next.example.test" },
    });
    return { request, url: new URL(request.url), route: { id: "/admin/join-attempts/[id]" } };
  };
  const recording = () => {
    const entries: AccessEntry[] = [];
    const sink = vi.fn(async (entry: AccessEntry) => {
      entries.push(entry);
      return true;
    });
    return { entries, sink };
  };
  const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
    appUrl: APP_URL,
    featuredImageHosts: "",
    honoFetch: vi.fn(async () => new Response("hono")),
    resolve: vi.fn(
      async () =>
        new Response(
          await keyedMemberRead(async () => {
            memberQueryPermit();
            declareMemberResult([SUBJECT]);
            return "<h1>Join attempt 7</h1>";
          }),
          { headers: { "content-type": "text/html" } },
        ),
    ),
    manifest: [{ ...detailEntry(), enabled: true }],
    sessionFor: vi.fn(async () => authenticated(VIEWER)),
    accessSink: async () => null,
    ...overrides,
  });

  it("releases the detail page only after auditing the moderator viewer", async () => {
    const { entries, sink } = recording();
    const res = await dispatchHookRequest(
      eventFor("/admin/join-attempts/7"),
      depsFor({ accessSink: async () => sink }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Join attempt 7</h1>");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(entries).toEqual([
      {
        viewerDiscordId: VIEWER,
        viewerUserId: VIEWER,
        resource: "join_attempts",
        action: "view",
        route: "admin.join-attempts.show",
        subjectUserIds: [SUBJECT],
      },
    ]);
  });

  it("audit refusal: no access sink fails closed with a sanitized 503 and no trace leak", async () => {
    const res = await dispatchHookRequest(
      eventFor("/admin/join-attempts/7"),
      depsFor({ accessSink: undefined }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    const body = await res.text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain(SUBJECT);
    expect(body).not.toContain(VIEWER);
  });

  it("audit refusal: an audit write that fails refuses the release", async () => {
    const failingSink = vi.fn(async () => {
      throw new Error("audit store unavailable");
    });
    const res = await dispatchHookRequest(
      eventFor("/admin/join-attempts/7"),
      depsFor({ accessSink: async () => failingSink }),
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain(SUBJECT);
  });

  it("role denial at the boundary: an unauthenticated viewer is refused, never audited as a release", async () => {
    const { entries, sink } = recording();
    const res = await dispatchHookRequest(
      eventFor("/admin/join-attempts/7"),
      depsFor({ accessSink: async () => sink, sessionFor: vi.fn(async () => guest()) }),
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain(SUBJECT);
    expect(entries).toEqual([]);
  });
});

describe("acceptance: detail page markup — escaped values, no JavaScript", () => {
  const page = () => read("web/src/routes/admin/join-attempts/[id]/+page.svelte");
  const loadSource = () => read("web/src/routes/admin/join-attempts/[id]/+page.server.ts");

  it("renders trace values as escaped text only: no raw-HTML interpolation anywhere", () => {
    const html = page();
    expect(html).not.toContain("{@html");
    expect(html).toContain("{view.outcome}");
    expect(html).toContain("{joinDiagnostic(view.requestId)}");
    expect(html).toContain("{joinDiagnostic(view.discordId)}");
    expect(html).toContain("<time datetime={view.createdAt}>{view.createdAt}</time>");
  });

  it("keeps the Hono contract: back link, Outcome/Trace lists, Not recorded labels", () => {
    const html = page();
    expect(html).toContain(
      'href={data.returnUrl ?? "/admin/join-attempts"}>Back to join attempts</a>',
    );
    expect(html).toContain("<h2>Outcome</h2>");
    expect(html).toContain("<h2>Trace</h2>");
    for (const term of [
      "<dt>Outcome</dt>",
      "<dt>Source</dt>",
      "<dt>Attempted at (UTC)</dt>",
      "<dt>Request ID</dt>",
      "<dt>Discord ID</dt>",
    ]) {
      expect(html).toContain(term);
    }
    expect(html.match(/joinDiagnostic\(view\.(source|requestId|discordId)\)/g)).toHaveLength(3);
    expect(html).not.toContain('?? "—"');
  });

  it("ships no JavaScript: server-rendered only, no island, handler, form or control", () => {
    expect(loadSource()).toContain("csr = false");
    const html = page();
    expect(html).not.toMatch(/<script src|islands\/|on:click|onClick|addEventListener/);
    expect(html).not.toMatch(/<form|<input|<button/);
  });

  it("load waits for moderator admission, maps missing/invalid to 404 and outage to 503, and marks bytes private", () => {
    const src = loadSource();
    expect(src).toContain("await parent()");
    expect(src).toContain("resolveKitJoinAttemptDetail");
    expect(src).toContain('error(404, "Join attempt not found")');
    expect(src).toContain('error(503, "Admin temporarily unavailable")');
    expect(src).toContain('setHeaders({ "cache-control": "private, no-store" })');
    // The hook boundary owns the audit; the load adds no second sink.
    expect(src).not.toMatch(/recordAccess|accessSink|cookies\.set|SESSION_STORE/);
    // One shared keyed read: no hand-rolled query in the route.
    expect(src).not.toMatch(/select\(|from\(|sql`|ilike|like\(/);
  });
});
