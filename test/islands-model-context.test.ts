// B1 stub contract: the minified model-context island registers exactly the
// four read-only public tools (T1–T4) on document.modelContext, no-ops when
// the API is absent, and tears down on navigation. Runs the shipped bytes in
// a vm double like the other island binder suites.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/model-context.js", import.meta.url),
  "utf8",
);

// Allowlisted synthetic ULID (see .gitleaks.toml): safe in test sources.
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const TOOL_NAMES = [
  "two_search_events",
  "two_get_event",
  "two_get_community",
  "two_get_join_info",
] as const;

type Registered = {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  options?: { signal?: AbortSignal };
};

function browser(
  opts: {
    documentContext?: Record<string, unknown> | null;
    navigatorContext?: Record<string, unknown> | null;
    documentCookie?: string;
    modelThrows?: boolean;
  } = {},
) {
  const registered: Registered[] = [];
  const provided: Array<{ tools: Registered[] }> = [];
  const cleared: unknown[][] = [];
  const fetched: Array<{ url: string; init?: RequestInit }> = [];
  const listeners = new Map<string, (event?: { persisted?: boolean }) => void>();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    fetched.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ url }),
    };
  });
  const documentContext = opts.documentContext === undefined ? null : opts.documentContext;
  const navigatorContext = opts.navigatorContext === undefined ? null : opts.navigatorContext;
  const sandbox: Record<string, unknown> = {
    AbortController,
    fetch: fetchImpl,
    document: {
      cookie: opts.documentCookie ?? "",
      get modelContext() {
        if (opts.modelThrows) throw new Error("denied");
        return documentContext;
      },
    },
    navigator: { modelContext: navigatorContext },
    window: {
      addEventListener: vi.fn((kind: string, fn: (event?: { persisted?: boolean }) => void) => {
        listeners.set(kind, fn);
      }),
      removeEventListener: vi.fn((kind: string) => {
        listeners.delete(kind);
      }),
    },
  };
  const makeContext = () => ({
    registerTool: vi.fn((tool: Registered, options?: { signal?: AbortSignal }) => {
      registered.push({ ...tool, options });
    }),
    provideContext: vi.fn((batch: { tools: Registered[] }) => {
      provided.push(batch);
    }),
    clearContext: vi.fn((...args: unknown[]) => {
      cleared.push(args);
    }),
  });
  const docCtx =
    documentContext === null && opts.documentContext === undefined
      ? null
      : (documentContext ?? makeContext());
  const navCtx =
    navigatorContext === null && opts.navigatorContext === undefined
      ? null
      : (navigatorContext ?? makeContext());
  // Rebuild the sandbox with real stub contexts (null stays null: API absent).
  sandbox.document = {
    cookie: opts.documentCookie ?? "",
    get modelContext() {
      if (opts.modelThrows) throw new Error("denied");
      return opts.documentContext === undefined ? docCtx : (opts.documentContext ?? null);
    },
  };
  sandbox.navigator = {
    modelContext: opts.navigatorContext === undefined ? navCtx : (opts.navigatorContext ?? null),
  };
  runInNewContext(binder, sandbox);
  return {
    registered,
    provided,
    fetched,
    fetchImpl,
    listeners,
    window: sandbox.window as {
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    },
    docCtx,
    navCtx,
    firePagehide(event?: { persisted?: boolean }) {
      listeners.get("pagehide")?.(event);
    },
    firePageshow(event?: { persisted?: boolean }) {
      listeners.get("pageshow")?.(event);
    },
  };
}

function withRegisterTool() {
  const ctx = {
    registerTool: vi.fn(),
    provideContext: vi.fn(),
    clearContext: vi.fn(),
  };
  const b = browser({ documentContext: ctx });
  const tools = (ctx.registerTool.mock.calls as Array<[Registered, { signal?: AbortSignal }]>).map(
    ([tool, options]) => ({ ...tool, options }),
  );
  return { b, ctx, tools };
}

describe("model-context island stub contract", () => {
  it("does nothing observable when the API is absent", () => {
    const b = browser();
    expect(b.fetchImpl).not.toHaveBeenCalled();
    expect(b.registered).toHaveLength(0);
    expect(b.provided).toHaveLength(0);
  });

  it("does nothing observable when modelContext access throws", () => {
    const b = browser({ modelThrows: true });
    expect(b.fetchImpl).not.toHaveBeenCalled();
  });

  it("registers exactly the four read-only tools with schemas and abort signals", () => {
    const { ctx, tools } = withRegisterTool();
    expect(ctx.provideContext).not.toHaveBeenCalled();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("prefers document.modelContext over navigator.modelContext", () => {
    const docCtx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    const navCtx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    browser({ documentContext: docCtx, navigatorContext: navCtx });
    expect(docCtx.registerTool).toHaveBeenCalledTimes(4);
    expect(navCtx.registerTool).not.toHaveBeenCalled();
  });

  it("uses the navigator alias when document has no modelContext", () => {
    const navCtx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    browser({ documentContext: null, navigatorContext: navCtx });
    expect(navCtx.registerTool).toHaveBeenCalledTimes(4);
  });

  it("falls back to one legacy provideContext batch without registerTool", () => {
    const legacy = { provideContext: vi.fn(), clearContext: vi.fn() };
    const b = browser({ documentContext: legacy });
    expect(b.registered).toHaveLength(0);
    expect(legacy.provideContext).toHaveBeenCalledTimes(1);
    const batch = legacy.provideContext.mock.calls[0]![0] as { tools: Registered[] };
    expect(batch.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("registers the same four tools for moderator sessions: no extra tools", () => {
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    browser({
      documentContext: ctx,
      documentCookie: "two_session=sess_moderator_probe; __Host-two_session_status=abc",
    });
    expect(ctx.registerTool).toHaveBeenCalledTimes(4);
    expect(
      (ctx.registerTool.mock.calls as Array<[Registered]>).map(([t]) => t.name).sort(),
    ).toEqual([...TOOL_NAMES].sort());
  });

  it("search_events clamps per_page to the 20-row API cap", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    }));
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    runInNewContext(binder, {
      AbortController,
      fetch: fetchImpl,
      document: { cookie: "", modelContext: ctx },
      navigator: {},
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const tool = (ctx.registerTool.mock.calls as Array<[Registered]>)
      .map(([t]) => t)
      .find((t) => t.name === "two_search_events")!;
    await tool.execute({ page: 2, per_page: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/public/events?page=2&per_page=20");
    await tool.execute({});
    expect(fetchImpl.mock.calls[1]![0]).toBe("/api/public/events?page=1&per_page=20");
  });

  it("search_events description states the real API order: earliest first, past events included", () => {
    const { tools } = withRegisterTool();
    const tool = tools.find((t) => t.name === "two_search_events")!;
    // listPublicApiEvents orders asc(startsAt), asc(id) over every published
    // event with no date filter (src/events/reads.ts); the OpenAPI summary is
    // "Published events, soonest first". The description is the only order
    // contract the model sees, so it must not claim newest first, nor call a
    // paged list without a query a search.
    expect(tool.description).toMatch(/earliest first/);
    expect(tool.description).toMatch(/past events/);
    expect(tool.description).not.toMatch(/newest first/i);
    expect(tool.description).not.toMatch(/^Search/);
  });

  it("get_event fetches the valid key and rejects junk without a request", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    }));
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    runInNewContext(binder, {
      AbortController,
      fetch: fetchImpl,
      document: { cookie: "", modelContext: ctx },
      navigator: {},
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const tool = (ctx.registerTool.mock.calls as Array<[Registered]>)
      .map(([t]) => t)
      .find((t) => t.name === "two_get_event")!;
    await tool.execute({ event_key: EVENT_KEY });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/public/events/${EVENT_KEY}`,
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    // Invalid keys fail closed synchronously, before any request leaves the page.
    await expect((async () => tool.execute({ event_key: "../../etc/passwd" }))()).rejects.toThrow();
    await expect((async () => tool.execute({}))()).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("community and join tools read their bounded endpoints", async () => {
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url }),
      json: async () => ({ url }),
    }));
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    runInNewContext(binder, {
      AbortController,
      fetch: fetchImpl,
      document: { cookie: "", modelContext: ctx },
      navigator: {},
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const byName = new Map(
      (ctx.registerTool.mock.calls as Array<[Registered]>).map(([t]) => [t.name, t]),
    );
    await expect(byName.get("two_get_community")!.execute({})).resolves.toEqual({
      url: "/api/public/community",
    });
    await expect(byName.get("two_get_join_info")!.execute({})).resolves.toEqual({
      url: "/api/public/join",
    });
  });

  it("pagehide aborts registrations and in-flight reads", async () => {
    // Settles only via the abort signal, like a real fetch would.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    const listeners = new Map<string, () => void>();
    runInNewContext(binder, {
      AbortController,
      fetch: fetchImpl,
      document: { cookie: "", modelContext: ctx },
      navigator: {},
      window: {
        addEventListener: vi.fn((kind: string, fn: () => void) => {
          listeners.set(kind, fn);
        }),
        removeEventListener: vi.fn(),
      },
    });
    const signals = (
      ctx.registerTool.mock.calls as Array<[Registered, { signal: AbortSignal }]>
    ).map(([, options]) => options.signal);
    expect(signals).toHaveLength(4);
    const tool = (ctx.registerTool.mock.calls as Array<[Registered]>)
      .map(([t]) => t)
      .find((t) => t.name === "two_get_community")!;
    const pending = tool.execute({});
    const silence = pending.catch(() => "aborted");
    listeners.get("pagehide")?.();
    for (const signal of signals) expect(signal!.aborted).toBe(true);
    await expect(silence).resolves.toBe("aborted");
  });

  it("legacy path clears context on pagehide", () => {
    const legacy = { provideContext: vi.fn(), clearContext: vi.fn() };
    const b = browser({ documentContext: legacy });
    b.firePagehide();
    expect(legacy.clearContext).toHaveBeenCalledTimes(1);
  });

  it("persisted pageshow re-registers tools with live signals after pagehide", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      // A stale aborted controller must fail the read, like a real fetch would.
      if (init?.signal?.aborted) {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      }
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({}),
      };
    });
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    const listeners = new Map<string, (event?: { persisted?: boolean }) => void>();
    runInNewContext(binder, {
      AbortController,
      fetch: fetchImpl,
      document: { cookie: "", modelContext: ctx },
      navigator: {},
      window: {
        // Honor { once: true } like a real EventTarget: a one-shot pagehide
        // listener is gone before the second navigation, so repeat teardown
        // silently stops working and the assertions below fail.
        addEventListener: vi.fn(
          (
            kind: string,
            fn: (event?: { persisted?: boolean }) => void,
            options?: { once?: boolean } | boolean,
          ) => {
            const once = typeof options === "object" && options !== null && options.once === true;
            if (once) {
              const original = fn;
              fn = (event?: { persisted?: boolean }) => {
                listeners.delete(kind);
                original(event);
              };
            }
            listeners.set(kind, fn);
          },
        ),
        removeEventListener: vi.fn(),
      },
    });
    expect(ctx.registerTool).toHaveBeenCalledTimes(4);
    // The page enters the back-forward cache: tools are torn down, and the
    // island does not run again on restore, so pageshow must re-register.
    listeners.get("pagehide")?.({ persisted: true });
    listeners.get("pageshow")?.({ persisted: true });
    expect(ctx.registerTool).toHaveBeenCalledTimes(8);
    const calls = ctx.registerTool.mock.calls as Array<[Registered, { signal?: AbortSignal }]>;
    const secondGen = calls.slice(4).map(([, options]) => options.signal!);
    expect(secondGen).toHaveLength(4);
    for (const signal of secondGen) expect(signal.aborted).toBe(false);
    // Reads after restore ride the fresh controller, not the aborted one: the
    // fetch stub above throws on an aborted signal at fetch time, so resolving
    // here proves liveness when the request issued. Settlement then aborts the
    // per-call controller to release the connection, so the captured signal
    // reads aborted after success.
    const restored = calls[4]![0];
    await expect(restored.execute({})).resolves.toEqual({});
    const lastInit = fetchImpl.mock.calls.at(-1)?.[1];
    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
    expect(lastInit?.signal?.aborted).toBe(true);
    // Teardown is repeatable (no once): leaving again aborts the new set.
    listeners.get("pagehide")?.({ persisted: true });
    for (const signal of secondGen) expect(signal.aborted).toBe(true);
    expect(lastInit?.signal?.aborted).toBe(true);
  });

  it("pageshow on first load does not duplicate registrations", () => {
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    const b = browser({ documentContext: ctx });
    b.firePageshow({ persisted: false });
    b.firePageshow();
    expect(ctx.registerTool).toHaveBeenCalledTimes(4);
  });

  it("legacy path re-provides tools when a persisted page returns", () => {
    const legacy = { provideContext: vi.fn(), clearContext: vi.fn() };
    const b = browser({ documentContext: legacy });
    b.firePagehide({ persisted: true });
    expect(legacy.clearContext).toHaveBeenCalledTimes(1);
    b.firePageshow({ persisted: true });
    expect(legacy.provideContext).toHaveBeenCalledTimes(2);
  });

  it("tool errors surface instead of resolving empty", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const ctx = { registerTool: vi.fn(), provideContext: vi.fn(), clearContext: vi.fn() };
    runInNewContext(binder, {
      AbortController,
      fetch: fetchImpl,
      document: { cookie: "", modelContext: ctx },
      navigator: {},
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const tool = (ctx.registerTool.mock.calls as Array<[Registered]>)
      .map(([t]) => t)
      .find((t) => t.name === "two_get_community")!;
    const error = (await tool.execute({}).then(
      () => null,
      (failure: unknown) => failure,
    )) as (Error & { code?: unknown }) | null;
    // The island constructs the failure inside its vm realm, so pin the shape
    // rather than the outer Error identity.
    expect(typeof error?.message).toBe("string");
    expect(error?.code).toBe("unavailable");
    expect(error?.message).toMatch(/try again/);
    expect(error?.message).not.toMatch(/503/);
  });
});

// C3 review pins (builder-owned): settle aborts and releases, 404 maps to
// not_found, the byte cap measures UTF-8 bytes, the Retry-After floor holds,
// and oversize streaming bodies stop early. The acceptance suite owns the
// broader bounds contract; these cases pin the review findings without
// touching its files.
type C3Timer = { fn: () => void; ms: number; cleared: boolean; fired: boolean };
type C3FetchCall = { url: string; init?: RequestInit };

function c3Island(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  const registered: Registered[] = [];
  const fetched: C3FetchCall[] = [];
  const timers: C3Timer[] = [];
  const listeners = new Map<string, (event?: { persisted?: boolean }) => void>();
  const wrappedFetch = async (url: string, init?: RequestInit) => {
    fetched.push({ url, init });
    return fetchImpl(url, init);
  };
  const fakeSetTimeout = (fn: () => void, ms = 0) => {
    timers.push({ fn, ms: Number(ms) || 0, cleared: false, fired: false });
    return timers.length;
  };
  const fakeClearTimeout = (id: number) => {
    const t = timers[id - 1];
    if (t) t.cleared = true;
  };
  const ctx = {
    registerTool: (tool: Registered, options?: { signal?: AbortSignal }) => {
      registered.push({ ...tool, options });
    },
    provideContext: () => {},
    clearContext: () => {},
  };
  runInNewContext(binder, {
    AbortController,
    TextEncoder,
    TextDecoder,
    fetch: wrappedFetch,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    document: { cookie: "", modelContext: ctx },
    navigator: {},
    window: {
      addEventListener: (kind: string, fn: (event?: { persisted?: boolean }) => void) => {
        listeners.set(kind, fn);
      },
      removeEventListener: (kind: string) => {
        listeners.delete(kind);
      },
    },
  });
  const byName = new Map(registered.map((t) => [t.name, t]));
  return {
    byName,
    fetched,
    timers,
    fireTimers() {
      for (const t of timers) {
        if (!t.cleared && !t.fired) {
          t.fired = true;
          t.fn();
        }
      }
    },
  };
}

function c3Headers(entries: Record<string, string>) {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) lower.set(k.toLowerCase(), v);
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function c3MultibyteJson(totalBytes: number): string {
  // {"a":"<pad>"} with two-byte "é" chars (one ASCII byte when the pad length
  // is odd) so the byte count hits exactly while chars stay well under bytes.
  const overhead = new TextEncoder().encode(JSON.stringify({ a: "" })).length;
  const padBytes = totalBytes - overhead;
  if (padBytes < 1) throw new Error(`fixture cannot hit ${totalBytes} bytes`);
  const pad = padBytes % 2 === 0 ? "é".repeat(padBytes / 2) : `x${"é".repeat((padBytes - 1) / 2)}`;
  const body = JSON.stringify({ a: pad });
  if (new TextEncoder().encode(body).length !== totalBytes) {
    throw new Error(`fixture missed ${totalBytes} bytes`);
  }
  return body;
}

describe("model-context C3 review pins", () => {
  it("aborts the per-call fetch when the deadline fires", async () => {
    let captured: AbortSignal | undefined;
    const b = c3Island(async (_url: string, init?: RequestInit) => {
      captured = init?.signal as AbortSignal | undefined;
      return new Promise(() => {});
    });
    const pending = b.byName.get("two_get_community")!.execute({});
    pending.catch(() => {});
    await Promise.resolve();
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    b.fireTimers();
    const failure = (await pending.then(
      () => null,
      (err: unknown) => err,
    )) as (Error & { code?: unknown }) | null;
    expect(failure?.code).toBe("timeout");
    expect(captured!.aborted).toBe(true);
  });

  it("settled successes already hold aborted signals instead of waiting for pagehide", async () => {
    const b = c3Island(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      headers: c3Headers({}),
      text: async () => "{}",
    }));
    const tool = b.byName.get("two_get_community")!;
    await expect(tool.execute({})).resolves.toEqual({});
    await expect(tool.execute({})).resolves.toEqual({});
    await expect(tool.execute({})).resolves.toEqual({});
    expect(b.fetched).toHaveLength(3);
    for (const call of b.fetched) {
      const signal = call.init?.signal as AbortSignal | undefined;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(true);
    }
  });

  it("maps 404 on get_event to not_found with no retry hint", async () => {
    const b = c3Island(async () => ({
      ok: false,
      status: 404,
      type: "basic",
      headers: c3Headers({}),
      text: async () => "",
    }));
    const failure = (await b.byName
      .get("two_get_event")!
      .execute({ event_key: EVENT_KEY })
      .then(
        () => null,
        (err: unknown) => err,
      )) as (Error & { code?: unknown; retryAfter?: unknown }) | null;
    expect(b.fetched).toHaveLength(1);
    expect(failure?.code).toBe("not_found");
    expect(typeof failure?.message).toBe("string");
    expect(failure?.message).toBe("No published event with that key.");
    expect(failure?.message).not.toMatch(/try again|retry|later/i);
    expect(failure?.retryAfter).toBeUndefined();
  });

  it("measures the cap in UTF-8 bytes: multibyte at-cap succeeds, char-under/byte-over refuses", async () => {
    const atCap = c3MultibyteJson(32768);
    expect(atCap.length).toBeLessThan(32768);
    const ok = c3Island(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      headers: c3Headers({}),
      text: async () => atCap,
    }));
    await expect(ok.byName.get("two_get_community")!.execute({})).resolves.toEqual(
      JSON.parse(atCap),
    );
    // 20008 chars / 40008 bytes: a .length mutant sees under-cap and resolves.
    const overBytes = c3MultibyteJson(40008);
    expect(overBytes.length).toBeLessThan(32768);
    const over = c3Island(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      headers: c3Headers({}),
      text: async () => overBytes,
    }));
    const failure = (await over.byName
      .get("two_get_community")!
      .execute({})
      .then(
        () => null,
        (err: unknown) => err,
      )) as (Error & { code?: unknown }) | null;
    expect(failure?.code).toBe("invalid_response");
  });

  it.each(["0", "-5"])("floors Retry-After %s at 1 second", async (raw) => {
    const b = c3Island(async () => ({
      ok: false,
      status: 429,
      type: "basic",
      headers: c3Headers({ "retry-after": raw }),
      text: async () => "{}",
    }));
    const failure = (await b.byName
      .get("two_get_community")!
      .execute({})
      .then(
        () => null,
        (err: unknown) => err,
      )) as (Error & { code?: unknown; retryAfter?: unknown }) | null;
    expect(b.fetched).toHaveLength(1);
    expect(failure?.code).toBe("rate_limited");
    expect(failure?.retryAfter).toBe(1);
  });

  it("stops an oversize streaming body early: cancel observed, tail never read", async () => {
    const chunk = new TextEncoder().encode(`x`.repeat(8000));
    const chunks = [chunk, chunk, chunk, chunk, chunk];
    let reads = 0;
    let cancelled = false;
    let textCalled = false;
    const b = c3Island(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      headers: c3Headers({}),
      text: async () => {
        textCalled = true;
        return "";
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (cancelled) return { done: true, value: undefined };
            if (reads >= chunks.length) return { done: true, value: undefined };
            const value = chunks[reads];
            reads += 1;
            return { done: false, value };
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    }));
    const failure = (await b.byName
      .get("two_get_community")!
      .execute({})
      .then(
        () => null,
        (err: unknown) => err,
      )) as (Error & { code?: unknown }) | null;
    expect(failure?.code).toBe("invalid_response");
    expect(textCalled).toBe(false);
    expect(cancelled).toBe(true);
    // 5 x 8000B: the 5th chunk passes 32768, so at most 5 reads run and the
    // 6th (done) read never issues.
    expect(reads).toBeLessThanOrEqual(5);
    const signal = b.fetched[0]!.init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
  });

  it("streams a small body to success without touching text()", async () => {
    const full = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const split = Math.ceil(full.length / 2);
    const parts = [full.slice(0, split), full.slice(split)];
    let reads = 0;
    let textCalled = false;
    const b = c3Island(async () => ({
      ok: true,
      status: 200,
      type: "basic",
      headers: c3Headers({}),
      text: async () => {
        textCalled = true;
        return "";
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (reads >= parts.length) return { done: true, value: undefined };
            const value = parts[reads];
            reads += 1;
            return { done: false, value };
          },
          cancel: async () => {},
        }),
      },
    }));
    await expect(b.byName.get("two_get_community")!.execute({})).resolves.toEqual({ ok: true });
    expect(textCalled).toBe(false);
    expect(reads).toBe(2);
  });
});
