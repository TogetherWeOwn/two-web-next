import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone probe tooling has no declaration file.
import * as probe from "../bin/admin-authwall-probe.mjs";

const { ADMIN_POST_PATHS, QA_HEADER, STAGING_URL, runProbe } = probe;

// Acceptance contract for the admin auth-wall probe:
// 1. Response disposal is inert. It is attempted exactly once per response,
//    but a synchronous throw, an immediate or late rejection, or a
//    never-settling cancel must not change any status/header verdict, stall
//    later checks, leak exception text, or surface as an unhandled rejection.
//    Cleanup never manufactures a passing verdict either.
// 2. Diagnostics are bounded and redacted. Pass/fail comparisons stay exact
//    internally, but an unexpected redirect target is rendered as a bounded
//    diagnostic class/shape, never as the arbitrary provider-controlled
//    string: synthetic secrets, control characters and oversized header
//    values must not escape into the returned report (which the CLI prints
//    verbatim as JSON).
// 3. The existing wall contract is preserved: all nine admin POST paths,
//    guest/member/moderator distinctions, manual redirects, empty write
//    bodies, staging-only target, environment-only QA token transport,
//    per-request abort budgets and genuine auth-wall failures.
//
// Every send is injected; no test here touches the network. Responses are
// structural doubles exposing exactly the surface the probe reads
// (status, headers.get, headers.getSetCookie, body.cancel). A double can
// carry header bytes a Headers constructor refuses to build in a fixture —
// in production the provider, not this file, controls those bytes. One
// real-Response transport below proves the doubles hide no incompatibility.

const TOKEN = "fixture-qa-token";
const SECRET = "synthetic-provider-secret-9f27";
const MARKER = "provider-marker-7c41";
const CONTROLS = String.fromCharCode(1, 27, 127);
const SECRET_LOCATION = `https://evil.example/${MARKER}?token=${SECRET}&next=${TOKEN}${CONTROLS}[31m`;
const OVERSIZED_LOCATION = `/${MARKER}/${"a".repeat(8000)}?t=${SECRET}`;

const cookieFor = (session: string) =>
  `__Host-two_session=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const MEMBER_SESSION = cookieFor("fixture-member-session");
const MODERATOR_SESSION = cookieFor("fixture-moderator-session");

// 9 guest POSTs + 1 cross-origin control + 1 guest GET + member login +
// 9 member POSTs + moderator login + 1 moderator GET.
const EXPECTED_SENDS = 23;
const EXPECTED_CHECKS = 40;

type Init = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  redirect?: string;
  signal?: unknown;
};
type Spec = { status: number; location?: string | null; cookies?: string[] };

type DisposalMode = "resolves" | "sync-throw" | "rejects" | "never-settles";

// The disposal error deliberately carries the token: no verdict, error,
// result or diagnostic produced from it may ever surface that text.
//
// The cancel doubles are plain functions with a manual calls counter, never
// vi.fn: @vitest/spy attaches its own .then(ok, err) to every Promise a mock
// returns, which would itself handle a disposal rejection and so mask a
// missing rejection handler in the probe. With a plain double, only the
// probe's own handler can keep a rejecting cancel from surfacing as an
// unhandledRejection.
type CancelDouble = {
  cancel: () => Promise<unknown>;
  calls: () => number;
};

function makeCancel(mode: DisposalMode): CancelDouble {
  let calls = 0;
  const counted = (impl: () => Promise<unknown>) => (): Promise<unknown> => {
    calls += 1;
    return impl();
  };
  switch (mode) {
    case "resolves":
      return { cancel: counted(async () => undefined), calls: () => calls };
    case "sync-throw":
      return {
        cancel: counted(() => {
          throw new Error(`dispose failed ${TOKEN}`);
        }),
        calls: () => calls,
      };
    case "rejects":
      return {
        cancel: counted(async () => {
          throw new Error(`dispose failed ${TOKEN}`);
        }),
        calls: () => calls,
      };
    case "never-settles":
      return { cancel: counted(() => new Promise<never>(() => {})), calls: () => calls };
  }
}

/** The expected wall: all three legs at their expected statuses. */
function greenSpec(path: string, init: Init): Spec {
  const method = init.method ?? "GET";
  const origin = init.headers?.origin ?? init.headers?.Origin;
  const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
  if (path.startsWith("/auth/qa/")) {
    if ((init.headers?.[QA_HEADER] ?? "") !== TOKEN) return { status: 404 };
    return {
      status: 204,
      cookies: [path.endsWith("qa-moderator") ? MODERATOR_SESSION : MEMBER_SESSION],
    };
  }
  if (method === "POST" && path.startsWith("/admin/")) {
    if (origin !== STAGING_URL) return { status: 403 };
    if (!cookie) return { status: 303, location: `/auth/recover?next=${encodeURIComponent(path)}` };
    return { status: 403 };
  }
  if (path === "/admin") {
    if (cookie.includes("moderator")) return { status: 200 };
    if (cookie) return { status: 403 };
    return { status: 302, location: "/auth/discord" };
  }
  return { status: 404 };
}

function doubleResponse(spec: Spec, cancel: CancelDouble | null) {
  return {
    status: spec.status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "location" ? (spec.location ?? null) : null),
      getSetCookie: () => spec.cookies ?? [],
    },
    body: cancel ? { cancel: cancel.cancel } : null,
  };
}

function realResponse(spec: Spec, cancel: CancelDouble | null) {
  const headers = new Headers();
  if (spec.location != null) headers.set("location", spec.location);
  for (const cookie of spec.cookies ?? []) headers.append("set-cookie", cookie);
  // A 204 carries no body in a real fetch, so its disposal is a no-op there.
  if (!cancel || spec.status === 204) return new Response(null, { status: spec.status, headers });
  const stream = new ReadableStream({ start() {} });
  Object.defineProperty(stream, "cancel", { value: cancel.cancel });
  return new Response(stream, { status: spec.status, headers });
}

type TransportOptions = {
  dispose?: DisposalMode | "null-body";
  cancelFor?: (path: string, init: Init) => CancelDouble | null;
  route?: (path: string, init: Init, fallback: Spec) => Spec;
  real?: boolean;
};

function makeTransport(options: TransportOptions = {}) {
  const calls: { url: string; init: Init }[] = [];
  const disposals: CancelDouble[] = [];
  const send = vi.fn(async (url: string, init: Init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const fallback = greenSpec(path, init);
    const spec = options.route ? options.route(path, init, fallback) : fallback;
    let cancel: CancelDouble | null;
    if (options.cancelFor) {
      cancel = options.cancelFor(path, init);
    } else if ((options.dispose ?? "resolves") === "null-body") {
      cancel = null;
    } else {
      cancel = makeCancel(options.dispose as DisposalMode);
    }
    if (cancel) disposals.push(cancel);
    return options.real ? realResponse(spec, cancel) : doubleResponse(spec, cancel);
  });
  return { send, calls, disposals };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

type ProbeResult = {
  passed: number;
  failed: number;
  failures: { label: string }[];
  [key: string]: unknown;
};

type Settled<T> =
  | { state: "resolved"; value: T }
  | { state: "rejected"; error: Error }
  | { state: "pending" };

// Classifies the outcome within a deadline so a stalled probe is a fast,
// specific assertion failure ("pending"), not an opaque test timeout.
async function settleValue<T>(promise: Promise<T>, ms = 750): Promise<Settled<T>> {
  return Promise.race([
    promise.then(
      (value) => ({ state: "resolved", value }) as Settled<T>,
      (error: unknown) => ({ state: "rejected", error: error as Error }) as Settled<T>,
    ),
    new Promise<Settled<T>>((resolve) => setTimeout(() => resolve({ state: "pending" }), ms)),
  ]);
}

function trackUnhandled() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return {
    unhandled,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function hasControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const FORBIDDEN = [TOKEN, SECRET, MARKER, "fixture-member-session", "fixture-moderator-session"];

/** The report the CLI prints: bounded per string, control-free, no secrets. */
function expectBoundedReport(result: unknown) {
  const json = JSON.stringify(result);
  for (const forbidden of FORBIDDEN) expect(json).not.toContain(forbidden);
  expect(json).not.toContain("dispose failed");
  for (const text of collectStrings(result)) {
    expect(text.length).toBeLessThanOrEqual(128);
    expect(hasControl(text)).toBe(false);
  }
}

function expectCleanError(error: Error, expected: string) {
  expect(error.message).toContain(expected);
  for (const forbidden of FORBIDDEN) expect(error.message).not.toContain(forbidden);
  expect(error.message).not.toContain("dispose failed");
}

const labelsOf = (result: { failures: { label: string }[] }) =>
  result.failures.map((failure) => failure.label);

describe("admin auth-wall probe disposal is inert to the verdict", () => {
  it("passes the whole wall when disposal resolves (positive control)", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("real network is forbidden in this suite");
    });
    vi.stubGlobal("fetch", globalFetch);
    try {
      const { send, calls, disposals } = makeTransport({ dispose: "resolves" });
      const settled = await settleValue(
        runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
      );
      expect(settled.state).toBe("resolved");
      if (settled.state !== "resolved") return;
      const result = settled.value;
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(EXPECTED_CHECKS);
      expect(result).toMatchObject({
        target: STAGING_URL,
        legs: { guest: "303 recovery", member: "403 forbidden", moderator: "200 dashboard" },
      });
      expectBoundedReport(result);
      // Later checks all ran: every leg, both logins, all nine paths twice.
      expect(calls).toHaveLength(EXPECTED_SENDS);
      // Disposal attempted exactly once per response; dropping it is not inertness.
      expect(disposals).toHaveLength(EXPECTED_SENDS);
      for (const disposal of disposals) expect(disposal.calls()).toBe(1);
      // Request contract: manual redirects, per-request abort budget,
      // empty admin write bodies, token only on the two QA logins.
      for (const { init } of calls) {
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
      const guestAndMemberPosts = calls.filter(
        ({ url, init }) => init.method === "POST" && new URL(url).pathname.startsWith("/admin/"),
      );
      expect(guestAndMemberPosts.length).toBeGreaterThanOrEqual(ADMIN_POST_PATHS.length * 2);
      for (const { init } of guestAndMemberPosts) expect(init.body).toBe("");
      const logins = calls.filter(({ url }) => new URL(url).pathname.startsWith("/auth/qa/"));
      expect(logins).toHaveLength(2);
      for (const { init } of logins) expect(init.headers?.[QA_HEADER]).toBe(TOKEN);
      for (const { init } of calls)
        if (!logins.some((login) => login.init === init))
          expect(JSON.stringify(init.headers ?? {})).not.toContain(TOKEN);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("passes the whole wall against null-body responses (positive control)", async () => {
    const { send, calls } = makeTransport({ dispose: "null-body" });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(EXPECTED_CHECKS);
    expect(calls).toHaveLength(EXPECTED_SENDS);
    expectBoundedReport(result);
  });

  it.each(["sync-throw", "rejects", "never-settles"] as const)(
    "passes the whole wall when disposal %s on every response",
    async (mode) => {
      const tracker = trackUnhandled();
      try {
        const { send, calls, disposals } = makeTransport({ dispose: mode });
        const settled = await settleValue(
          runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
        );
        await flush();
        expect(settled.state).toBe("resolved");
        if (settled.state !== "resolved") return;
        const result = settled.value;
        expect(result.failed).toBe(0);
        expect(result.passed).toBe(EXPECTED_CHECKS);
        expectBoundedReport(result);
        // A stalled or failed disposal must not halt later checks.
        expect(calls).toHaveLength(EXPECTED_SENDS);
        expect(disposals).toHaveLength(EXPECTED_SENDS);
        for (const disposal of disposals) expect(disposal.calls()).toBe(1);
      } finally {
        tracker.stop();
      }
      expect(tracker.unhandled).toEqual([]);
    },
  );

  it("settles the verdict before a late disposal rejection and swallows it without a trace", async () => {
    let rejectCancel!: (error: Error) => void;
    let lateCalls = 0;
    let first = true;
    const cancelFor = (): CancelDouble => {
      if (!first) return makeCancel("resolves");
      first = false;
      // Plain function, not vi.fn (see makeCancel): only the probe's own
      // handler can keep this late rejection from going unhandled.
      return {
        cancel: (): Promise<never> => {
          lateCalls += 1;
          return new Promise<never>((_resolve, reject) => {
            rejectCancel = reject;
          });
        },
        calls: () => lateCalls,
      };
    };
    const tracker = trackUnhandled();
    const consoleCalls: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args.map((arg) => String(arg)).join(" "));
      }),
    );
    let settledBeforeRejection = false;
    let result: { failed: number; passed: number } | undefined;
    let failure: Error | undefined;
    try {
      const { send } = makeTransport({ cancelFor });
      const pending = runProbe({ token: TOKEN, fetch: send }) as Promise<{
        failed: number;
        passed: number;
      }>;
      void pending.then(
        () => {
          settledBeforeRejection = true;
        },
        () => {
          settledBeforeRejection = true;
        },
      );
      await flush();
      const wasSettled = settledBeforeRejection;
      rejectCancel(new Error(`late dispose failed ${TOKEN}`));
      result = await pending.catch((error: Error) => {
        failure = error;
        return undefined;
      });
      settledBeforeRejection = wasSettled;
      await flush();
    } finally {
      tracker.stop();
      for (const spy of spies) spy.mockRestore();
    }
    // The verdict was already reached while disposal was still pending.
    expect(settledBeforeRejection).toBe(true);
    expect(failure).toBeUndefined();
    expect(result).toMatchObject({ failed: 0, passed: EXPECTED_CHECKS });
    expect(lateCalls).toBe(1);
    expect(tracker.unhandled).toEqual([]);
    expect(consoleCalls.join("\n")).not.toContain(TOKEN);
    expectBoundedReport(result);
  });

  it("still reports a genuine wall failure when disposal rejects (cleanup manufactures no pass)", async () => {
    const tracker = trackUnhandled();
    try {
      const { send, calls } = makeTransport({
        dispose: "rejects",
        route: (path, init, fallback) => {
          const cookie = init.headers?.Cookie ?? "";
          // A member POST that succeeds instead of 403ing: the wall is down.
          if (path === "/admin/events" && init.method === "POST" && cookie.includes("member"))
            return { status: 200 };
          return fallback;
        },
      });
      const settled = await settleValue(
        runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
      );
      await flush();
      expect(settled.state).toBe("resolved");
      if (settled.state !== "resolved") return;
      expect(settled.value.failed).toBeGreaterThan(0);
      expect(labelsOf(settled.value)).toContain("member POST /admin/events status");
      expectBoundedReport(settled.value);
      expect(calls).toHaveLength(EXPECTED_SENDS);
    } finally {
      tracker.stop();
    }
    expect(tracker.unhandled).toEqual([]);
  });

  it("still reports a genuine wall failure when disposal never settles", async () => {
    const { send, calls } = makeTransport({
      dispose: "never-settles",
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
        // A guest POST answered 200 with no bounce: the wall is down.
        if (path === "/admin/events" && init.method === "POST" && !cookie) return { status: 200 };
        return fallback;
      },
    });
    const settled = await settleValue(
      runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
    );
    expect(settled.state).toBe("resolved");
    if (settled.state !== "resolved") return;
    expect(settled.value.failed).toBeGreaterThan(0);
    expect(labelsOf(settled.value)).toContain("guest POST /admin/events status");
    expectBoundedReport(settled.value);
    expect(calls).toHaveLength(EXPECTED_SENDS);
  });

  it("keeps the QA login refusal when only the login disposal rejects", async () => {
    const tracker = trackUnhandled();
    try {
      const { send } = makeTransport({
        cancelFor: (path) => makeCancel(path.startsWith("/auth/qa/") ? "rejects" : "resolves"),
        route: (path, _init, fallback) =>
          path.startsWith("/auth/qa/") ? { status: 404 } : fallback,
      });
      const settled = await settleValue(
        runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
      );
      await flush();
      expect(settled.state).toBe("rejected");
      if (settled.state !== "rejected") return;
      expectCleanError(settled.error, "QA login as qa-member refused (HTTP 404)");
    } finally {
      tracker.stop();
    }
    expect(tracker.unhandled).toEqual([]);
  });

  it("keeps the QA login refusal with resolving disposal (refusal control)", async () => {
    const { send } = makeTransport({
      dispose: "resolves",
      route: (path, _init, fallback) => (path.startsWith("/auth/qa/") ? { status: 404 } : fallback),
    });
    const settled = await settleValue(
      runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
    );
    expect(settled.state).toBe("rejected");
    if (settled.state !== "rejected") return;
    expectCleanError(settled.error, "QA login as qa-member refused (HTTP 404)");
  });

  it("passes the whole wall through real Response bodies when disposal resolves (control)", async () => {
    const { send, disposals } = makeTransport({ dispose: "resolves", real: true });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(EXPECTED_CHECKS);
    // Every body-bearing response was cancelled once; the two 204 logins
    // have no body to cancel in a real fetch.
    expect(disposals.reduce((total, disposal) => total + disposal.calls(), 0)).toBe(
      EXPECTED_SENDS - 2,
    );
  });

  it("passes the whole wall through real Response bodies when disposal rejects", async () => {
    const tracker = trackUnhandled();
    try {
      const { send, calls } = makeTransport({ dispose: "rejects", real: true });
      const settled = await settleValue(
        runProbe({ token: TOKEN, fetch: send }) as Promise<ProbeResult>,
      );
      await flush();
      expect(settled.state).toBe("resolved");
      if (settled.state !== "resolved") return;
      expect(settled.value.failed).toBe(0);
      expect(settled.value.passed).toBe(EXPECTED_CHECKS);
      expectBoundedReport(settled.value);
      expect(calls).toHaveLength(EXPECTED_SENDS);
    } finally {
      tracker.stop();
    }
    expect(tracker.unhandled).toEqual([]);
  });
});

describe("admin auth-wall probe diagnostics are bounded and redacted", () => {
  it("redacts a secret-bearing guest redirect target instead of retaining it verbatim", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
        if (path === "/admin/events" && init.method === "POST" && !cookie)
          return { status: 303, location: SECRET_LOCATION };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    // The comparison stays exact: this is still a genuine failure.
    expect(result.failed).toBeGreaterThan(0);
    expect(labelsOf(result)).toContain("guest POST /admin/events recovery target");
    expectBoundedReport(result);
  });

  it("redacts a secret-bearing guest /admin location instead of retaining it verbatim", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
        if (path === "/admin" && !cookie) return { status: 302, location: SECRET_LOCATION };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(labelsOf(result)).toContain("guest GET /admin location");
    expectBoundedReport(result);
  });

  it("redacts a secret-bearing member location instead of retaining it verbatim", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? "";
        if (path === "/admin/events" && init.method === "POST" && cookie.includes("member"))
          return { status: 403, location: SECRET_LOCATION };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(labelsOf(result)).toContain("member POST /admin/events location");
    expectBoundedReport(result);
  });

  it("bounds an oversized redirect target in the returned report", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
        if (init.method === "POST" && path.startsWith("/admin/") && !cookie)
          return { status: 303, location: OVERSIZED_LOCATION };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expectBoundedReport(result);
    // Ten retained failures must not multiply an unbounded string either.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4096);
  });

  it("keeps the exact recovery comparison: a near-miss target still fails (control)", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
        if (path === "/admin/events" && init.method === "POST" && !cookie)
          return { status: 303, location: "/auth/recover" };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(labelsOf(result)).toContain("guest POST /admin/events recovery target");
    expectBoundedReport(result);
  });

  it("keeps the exact dashboard-bounce comparison: a near-miss location still fails (control)", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? "";
        if (path === "/admin" && !cookie) return { status: 302, location: "/auth/discord/" };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(labelsOf(result)).toContain("guest GET /admin location");
    expectBoundedReport(result);
  });

  it("keeps the exact member comparison: any location on a 403 still fails (control)", async () => {
    const { send } = makeTransport({
      route: (path, init, fallback) => {
        const cookie = init.headers?.Cookie ?? "";
        if (path === "/admin/events" && init.method === "POST" && cookie.includes("member"))
          return { status: 403, location: "/admin" };
        return fallback;
      },
    });
    const result = await runProbe({ token: TOKEN, fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(labelsOf(result)).toContain("member POST /admin/events location");
    expectBoundedReport(result);
  });

  it("refuses unsafe targets and a missing token before any send (refusal control)", async () => {
    const { send } = makeTransport();
    const nonStaging = await settleValue(
      runProbe({ baseUrl: "https://togetherweown.com", token: TOKEN, fetch: send }),
    );
    expect(nonStaging.state).toBe("rejected");
    const missingToken = await settleValue(runProbe({ token: "", fetch: send }));
    expect(missingToken.state).toBe("rejected");
    expect(send).not.toHaveBeenCalled();
  });
});
