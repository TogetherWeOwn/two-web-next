import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { request, type APIRequestContext } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QA_SESSION_COOKIE } from "../e2e/qa-request.mjs";
import { persistRotatedStorageState } from "../e2e/staging/fixtures";

type AfterEachHook = (args: { context: APIRequestContext }) => Promise<unknown>;
type PersistFn = (context: never, path: string) => Promise<void>;

type StorageStateCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "None" | "Strict";
};

type StorageStateFile = {
  cookies: StorageStateCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
};

type Journey = { heading: string; predecessor: string; successor: string };

const journeys: Record<string, Journey> = {
  "/profile": {
    heading: "QA Member",
    predecessor: "member-predecessor",
    successor: "member-successor",
  },
  "/admin": {
    heading: "QA Moderator",
    predecessor: "moderator-predecessor",
    successor: "moderator-successor",
  },
};

const enrolledSpecs = [
  { file: "e2e/staging/profile.spec.ts", stateKey: "memberStorageState", path: "/profile" },
  { file: "e2e/staging/admin.spec.ts", stateKey: "moderatorStorageState", path: "/admin" },
] as const;

let server: Server | undefined;
let origin = "";
let scratchDir = "";
const spentPredecessors = new Set<string>();

function sessionCookie(requestCookie: string | undefined): string | undefined {
  return requestCookie
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === QA_SESSION_COOKIE)?.[1];
}

function storageStateFor(value: string): StorageStateFile {
  return {
    cookies: [
      {
        name: QA_SESSION_COOKIE,
        value,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        // HTTP loopback only: Secure/__Host- enforcement is proven by the
        // real sign-in seam, not by this handoff proof.
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

function writeGuestResponse(response: ServerResponse): void {
  response.setHeader(
    "Set-Cookie",
    `${QA_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
  response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  response.end("<h1>Guest</h1>");
}

// Observed wrapper: every real helper promise is tracked so probes can drain
// helper writes (not just the hook promise) before reading the verdict file.
function trackPersist(calls: Promise<unknown>[]): PersistFn {
  return (context, path) => {
    const pending = persistRotatedStorageState(context as unknown as APIRequestContext, path);
    calls.push(pending);
    return pending;
  };
}

// Compile one staging spec to CJS and execute it in a fresh vm realm with a
// stubbed require. The ./fixtures stub exposes ONLY the spec's own state key
// at the temp path (the other key points at a decoy file, so a swapped key
// writes the decoy and fails the read below) and an observed persist wrapper
// that tracks every real helper promise; ./qa-login throws so capture runs
// can never sign in.
async function captureAfterEachHooks(
  specFile: string,
  stateKey: string,
  statePath: string,
): Promise<{
  hooks: AfterEachHook[];
  qaLoginCalled: boolean;
  persistCalls: Promise<unknown>[];
  decoyPath: string;
}> {
  const source = await readFile(new URL(`../${specFile}`, import.meta.url), "utf8");
  const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;

  const hooks: AfterEachHook[] = [];
  const persistCalls: Promise<unknown>[] = [];
  let qaLoginCalled = false;
  const qaLoginStub = (): Promise<never> => {
    qaLoginCalled = true;
    throw new Error("./qa-login must not execute during hook capture");
  };

  const testFn = ((..._args: unknown[]): void => undefined) as unknown as Record<string, unknown>;
  testFn.afterEach = (hook: AfterEachHook): void => {
    hooks.push(hook);
  };
  testFn.beforeAll = (): void => undefined;
  testFn.use = (): void => undefined;
  testFn.setTimeout = (): void => undefined;

  const otherKey =
    stateKey === "memberStorageState" ? "moderatorStorageState" : "memberStorageState";
  const decoyPath = `${statePath}.decoy-${otherKey}.json`;
  const fixturesStub = {
    test: testFn,
    expect: (): unknown => {
      throw new Error("spec test bodies must not run during hook capture");
    },
    [stateKey]: statePath,
    [otherKey]: decoyPath,
    emptyStorageState: { cookies: [], origins: [] },
    persistRotatedStorageState: trackPersist(persistCalls),
  };

  const customRequire = (id: string): unknown => {
    if (id === "./fixtures") return fixturesStub;
    if (id === "./qa-login") {
      return {
        loginQaMember: qaLoginStub,
        loginQaModerator: qaLoginStub,
        loginQaIdentities: qaLoginStub,
      };
    }
    if (id === "../qa-login-retry.mjs") return { qaLoginRetryBudgetMs: () => 0 };
    throw new Error(`unexpected require during hook capture: ${id}`);
  };

  const moduleObject = { exports: {} as Record<string, unknown> };
  const sandbox: Record<string, unknown> = {
    require: customRequire,
    module: moduleObject,
    exports: moduleObject.exports,
    console,
    setTimeout,
    clearTimeout,
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(compiled, sandbox, { filename: specFile });
  return { hooks, qaLoginCalled, persistCalls, decoyPath };
}

// Deferred-persistence probe: the hook runs against a context whose
// storageState() stays pending until released. An awaiting hook stays pending;
// a hook that never persists leaves the file untouched, and an unawaited call
// settles early. Every tracked helper promise drains in the finally after the
// gate releases, so unawaited writes cannot leak past the verdict.
async function classifyHook(
  hook: (args: { context: never }) => unknown,
  statePath: string,
  persistCalls: Promise<unknown>[] = [],
): Promise<"awaited" | "early-finish" | "no-persist"> {
  const sentinel = `sentinel-${Date.now()}-${Math.random()}`;
  await writeFile(statePath, sentinel);
  const trackedFrom = persistCalls.length;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let storageStateCalled = false;
  const gatedContext = {
    async storageState(): Promise<StorageStateFile> {
      storageStateCalled = true;
      await gate;
      return storageStateFor("probe-successor");
    },
  };

  let settled = false;
  let hookError: unknown;
  const pending = Promise.resolve()
    .then(() => hook({ context: gatedContext as never }))
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        hookError = error;
      },
    );

  // One macrotask turn, no wall clock: every microtask the hook can perform
  // (invocation, storageState call, early resolve) drains before setImmediate.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledEarly = settled;
  const earlyBytes = await readFile(statePath, "utf8");
  try {
    release();
    await pending;
    if (hookError) throw hookError;
  } finally {
    release();
    await Promise.allSettled(persistCalls.slice(trackedFrom));
  }
  const finalBytes = await readFile(statePath, "utf8");

  if (!storageStateCalled) return "no-persist";
  if (settledEarly && earlyBytes === sentinel) return "early-finish";
  if (!settledEarly && finalBytes !== sentinel) return "awaited";
  if (settledEarly) return "early-finish";
  return "no-persist";
}

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "two-staging-lifecycle-"));
  const localServer = createServer((incoming, response) => {
    const journey = journeys[incoming.url ?? ""];
    if (!journey) {
      response.writeHead(404).end();
      return;
    }
    const bearer = sessionCookie(incoming.headers.cookie);
    const key = `${incoming.url}:${journey.predecessor}`;
    const freshPredecessor = bearer === journey.predecessor && !spentPredecessors.has(key);
    if (freshPredecessor) {
      spentPredecessors.add(key);
      response.setHeader(
        "Set-Cookie",
        `${QA_SESSION_COOKIE}=${journey.successor}; Path=/; HttpOnly; SameSite=Lax`,
      );
    }
    if (!freshPredecessor && bearer !== journey.successor) {
      writeGuestResponse(response);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<h1>${journey.heading}</h1>`);
  });
  server = localServer;
  await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const address = localServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const runningServer = server;
  if (runningServer?.listening) {
    await new Promise<void>((resolve, reject) =>
      runningServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (scratchDir) await rm(scratchDir, { force: true, recursive: true });
});

describe("staging session lifecycle (runtime hook capture)", () => {
  for (const { file, stateKey, path } of enrolledSpecs) {
    const journey = journeys[path]!;

    it(`runs the real ${file} afterEach hook and keeps the next context authenticated`, async () => {
      const statePath = join(scratchDir, `${journey.successor}-${stateKey}.json`);
      await writeFile(statePath, JSON.stringify(storageStateFor(journey.predecessor)));
      const { hooks, qaLoginCalled, decoyPath } = await captureAfterEachHooks(
        file,
        stateKey,
        statePath,
      );
      expect(qaLoginCalled, "./qa-login must never execute during hook capture").toBe(false);
      expect(hooks, `${file} must register exactly one test.afterEach hook`).toHaveLength(1);

      const first = await request.newContext({ baseURL: origin, storageState: statePath });
      try {
        expect((await first.get(path)).status()).toBe(200);
        await hooks[0]!({ context: first });
      } finally {
        await first.dispose();
      }

      const stored = JSON.parse(await readFile(statePath, "utf8")) as StorageStateFile;
      const sessions = stored.cookies.filter((cookie) => cookie.name === QA_SESSION_COOKIE);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        value: journey.successor,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      });
      expect(sessions.map((cookie) => cookie.value)).not.toContain(journey.predecessor);
      // The hook must persist through its enrolled key only; a swapped key
      // writes the decoy path and fails this read.
      await expect(readFile(decoyPath, "utf8")).rejects.toThrow();

      const second = await request.newContext({ baseURL: origin, storageState: statePath });
      try {
        const view = await second.get(path);
        expect(view.status()).toBe(200);
        expect(await view.text()).toContain(journey.heading);
      } finally {
        await second.dispose();
      }
    });

    it(`proves the real ${file} afterEach hook awaits persistence before finishing`, async () => {
      const statePath = join(scratchDir, `deferred-${journey.successor}-${stateKey}.json`);
      const { hooks, persistCalls } = await captureAfterEachHooks(file, stateKey, statePath);
      expect(hooks).toHaveLength(1);
      await expect(classifyHook(hooks[0]!, statePath, persistCalls)).resolves.toBe("awaited");
    });
  }

  it("flags dead or unawaited hook shapes instead of passing them", async () => {
    const shapes: Array<{
      name: string;
      expected: "no-persist" | "early-finish";
      make: (persist: PersistFn, path: string) => (args: { context: never }) => unknown;
    }> = [
      {
        name: "if-false",
        expected: "no-persist",
        make:
          (persist, path) =>
          async ({ context }) => {
            if (false) {
              await persist(context, path);
            }
          },
      },
      {
        name: "after-return",
        expected: "no-persist",
        make: () => async () => undefined,
      },
      {
        name: "uncalled-nested",
        expected: "no-persist",
        make:
          (persist, path) =>
          async ({ context }) => {
            const save = async (): Promise<void> => {
              await persist(context, path);
            };
            void save;
          },
      },
      {
        name: "unawaited",
        expected: "early-finish",
        make:
          (persist, path) =>
          ({ context }) => {
            void persist(context, path);
          },
      },
    ];
    for (const shape of shapes) {
      const statePath = join(scratchDir, `control-${shape.name}.json`);
      const calls: Promise<unknown>[] = [];
      const verdict = await classifyHook(
        shape.make(trackPersist(calls), statePath),
        statePath,
        calls,
      );
      expect(verdict, shape.name).toBe(shape.expected);
    }
  });

  it("leaves the persisted jar byte-for-byte intact for guest jars", async () => {
    const base = {
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      secure: false,
      sameSite: "Lax",
    } as const;
    const guests: Array<{ name: string; cookies: StorageStateCookie[] }> = [
      {
        name: "unrelated",
        cookies: [{ name: "unrelated-cookie", value: "unrelated-value", ...base, httpOnly: false }],
      },
      {
        name: "empty-session",
        cookies: [{ name: QA_SESSION_COOKIE, value: "", ...base, httpOnly: true }],
      },
    ];
    for (const guest of guests) {
      const statePath = join(scratchDir, `no-clobber-${guest.name}.json`);
      const authenticated = JSON.stringify(storageStateFor("live-successor"));
      await writeFile(statePath, authenticated);
      const context = await request.newContext({
        storageState: { cookies: guest.cookies, origins: [] },
      });
      try {
        await persistRotatedStorageState(context, statePath);
      } finally {
        await context.dispose();
      }
      expect(await readFile(statePath, "utf8"), guest.name).toBe(authenticated);
    }
  });
});
