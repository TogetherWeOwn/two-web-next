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
    // Reads after restore ride the fresh controller, not the aborted one.
    const restored = calls[4]![0];
    await expect(restored.execute({})).resolves.toEqual({});
    const lastInit = fetchImpl.mock.calls.at(-1)?.[1];
    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
    expect(lastInit?.signal?.aborted).toBe(false);
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
