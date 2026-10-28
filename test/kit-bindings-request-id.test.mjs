// Kit binding requestId forwarding: the hotzones index, hotzones [signal]
// and members-board page bindings must pass locals.requestId into their load
// helpers (and into their own alertRequestError calls for failures the helper
// could not see). The dispatch suite pins that the helpers forward a passed
// id to error.alert; this file pins that the production bindings supply it —
// deleting the forwarding kept those suites green because they call the
// helpers directly.
//
// Same bundling pattern as test/kit-activity-log-load.test.mjs: the root
// Vitest config does not run SvelteKit's sync hook, so bundle each real route
// with esbuild, stubbing only its framework, env, db, alert and helper
// imports. The [signal] season grammar stays real (pure, zero imports).
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const RAY = "0123456789abcdef-LHR";

const sveltekitStub = `export function error(status, message) {
  throw Object.assign(new Error(message), { status });
}
export function redirect(status, location) {
  throw Object.assign(new Error("redirect"), { status, location });
}`;
const workersStub = "export const env = {};";
const dbStub = "export async function dbFor() { return null; };";
const alertsStub = `export function alertRequestError(err, fields) {
  globalThis.__bindingAlertCalls.push({ err, fields });
}`;
const gridStub =
  "export async function renderHotzoneGrid() { return 'grid'; }; export function renderPeriodPicker() { return 'picker'; };";
const journeyStub = "export const JOURNEY_TTL_SECONDS = 600;";

async function bundleRoute(entryRelPath, stubs) {
  const virtualModules = new Map(Object.entries(stubs));
  const namespace = `kit-bindings-request-id:${entryRelPath}`;
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../web/src/routes/${entryRelPath}`, import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: namespace,
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace,
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace,
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({ path: "db", namespace }));
          build.onResolve({ filter: /src\/alerts$/ }, () => ({ path: "alerts", namespace }));
          build.onResolve({ filter: /src\/hotzones\/pages$/ }, () => ({
            path: "grid",
            namespace,
          }));
          build.onResolve({ filter: /src\/kit-hotzones$/ }, () => ({
            path: "kit-hotzones",
            namespace,
          }));
          build.onResolve({ filter: /src\/kit-members$/ }, () => ({
            path: "kit-members",
            namespace,
          }));
          build.onResolve({ filter: /src\/return-journey$/ }, () => ({
            path: "journey",
            namespace,
          }));
          build.onLoad({ filter: /.*/, namespace }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
          }));
        },
      },
    ],
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return (await import(bundled)).load;
}

let hotzonesIndexLoad;
let hotzoneSignalLoad;
let membersBoardLoad;

beforeAll(async () => {
  hotzonesIndexLoad = await bundleRoute("hotzones/+page.server.ts", {
    sveltekit: sveltekitStub,
    "cloudflare-workers": workersStub,
    db: dbStub,
    alerts: alertsStub,
    grid: gridStub,
    "kit-hotzones": `export async function loadHotzonesIndexData(args) {
      globalThis.__hotzonesIndexCalls.push(args);
      if (globalThis.__hotzonesIndexImpl) return globalThis.__hotzonesIndexImpl(args);
      return {
        season: "all",
        joins: { cells: [], total: 0, eventCount: 0 },
        voice: { cells: [] },
        games: { cells: [] },
        retentionNote: null,
        appUrl: "https://example.test",
      };
    }`,
  });
  hotzoneSignalLoad = await bundleRoute("hotzones/[signal]/+page.server.ts", {
    sveltekit: sveltekitStub,
    "cloudflare-workers": workersStub,
    db: dbStub,
    alerts: alertsStub,
    grid: gridStub,
    "kit-hotzones": `export async function loadHotzoneSignalData(args) {
      globalThis.__hotzoneSignalCalls.push(args);
      if (globalThis.__hotzoneSignalImpl) return globalThis.__hotzoneSignalImpl(args);
      return {
        signal: "joins",
        season: "all",
        cells: [],
        total: 0,
        eventCount: 0,
        retentionNote: null,
        estimated: false,
        appUrl: "https://example.test",
      };
    }`,
  });
  membersBoardLoad = await bundleRoute("leaderboards/members/+page.server.ts", {
    sveltekit: sveltekitStub,
    "cloudflare-workers": workersStub,
    db: dbStub,
    alerts: alertsStub,
    journey: journeyStub,
    "kit-members": `export async function loadMembersBoardData(args) {
      globalThis.__membersBoardCalls.push(args);
      if (globalThis.__membersBoardImpl) return globalThis.__membersBoardImpl(args);
      return { board: [] };
    }
    export function queueMembersBoardView(locals, db, entry, requestId) {
      globalThis.__queueMembersBoardCalls.push({ locals, db, entry, requestId });
    }`,
  });
});

beforeEach(() => {
  globalThis.__bindingAlertCalls = [];
  globalThis.__hotzonesIndexCalls = [];
  globalThis.__hotzoneSignalCalls = [];
  globalThis.__membersBoardCalls = [];
  globalThis.__queueMembersBoardCalls = [];
  delete globalThis.__hotzonesIndexImpl;
  delete globalThis.__hotzoneSignalImpl;
  delete globalThis.__membersBoardImpl;
});

const setHeaders = () => {};
const authedLocals = (requestId) => ({
  status: "authenticated",
  session: { userId: "u-viewer", username: "viewer", member: true },
  requestId,
});

describe("hotzones index binding: requestId forwarding", () => {
  const url = () => new URL("https://example.test/hotzones");

  it("passes locals.requestId to the helper", async () => {
    await hotzonesIndexLoad({ url: url(), locals: { requestId: RAY }, setHeaders });
    expect(globalThis.__hotzonesIndexCalls).toHaveLength(1);
    expect(globalThis.__hotzonesIndexCalls[0].requestId).toBe(RAY);
  });

  it("forwards undefined when locals carries no id", async () => {
    await hotzonesIndexLoad({ url: url(), locals: {}, setHeaders });
    expect(globalThis.__hotzonesIndexCalls).toHaveLength(1);
    expect(globalThis.__hotzonesIndexCalls[0].requestId).toBeUndefined();
  });

  it("alerts an unseen failure with the binding id and answers 503", async () => {
    globalThis.__hotzonesIndexImpl = async () => {
      throw new TypeError("probe: cannot read properties of undefined");
    };
    const err = await hotzonesIndexLoad({
      url: url(),
      locals: { requestId: RAY },
      setHeaders,
    }).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(globalThis.__bindingAlertCalls).toHaveLength(1);
    expect(globalThis.__bindingAlertCalls[0].fields).toMatchObject({
      route: "/hotzones",
      requestId: RAY,
    });
  });
});

describe("hotzones signal binding: requestId forwarding", () => {
  const url = () => new URL("https://example.test/hotzones/joins");

  it("passes locals.requestId to the helper", async () => {
    await hotzoneSignalLoad({
      params: { signal: "joins" },
      url: url(),
      locals: { requestId: RAY },
      setHeaders,
    });
    expect(globalThis.__hotzoneSignalCalls).toHaveLength(1);
    expect(globalThis.__hotzoneSignalCalls[0].requestId).toBe(RAY);
  });

  it("forwards undefined when locals carries no id", async () => {
    await hotzoneSignalLoad({
      params: { signal: "joins" },
      url: url(),
      locals: {},
      setHeaders,
    });
    expect(globalThis.__hotzoneSignalCalls).toHaveLength(1);
    expect(globalThis.__hotzoneSignalCalls[0].requestId).toBeUndefined();
  });

  it("alerts an unseen failure with the binding id and answers 503", async () => {
    globalThis.__hotzoneSignalImpl = async () => {
      throw new TypeError("probe: cannot read properties of undefined");
    };
    const err = await hotzoneSignalLoad({
      params: { signal: "joins" },
      url: url(),
      locals: { requestId: RAY },
      setHeaders,
    }).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(globalThis.__bindingAlertCalls).toHaveLength(1);
    expect(globalThis.__bindingAlertCalls[0].fields).toMatchObject({
      route: "/hotzones/:signal",
      requestId: RAY,
    });
  });
});

describe("members-board binding: requestId forwarding", () => {
  const url = () => new URL("https://example.test/leaderboards/members");
  const cookies = {};

  it("passes locals.requestId to the helper", async () => {
    const out = await membersBoardLoad({
      url: url(),
      locals: authedLocals(RAY),
      cookies,
      setHeaders,
    });
    expect(out).toEqual({ board: [] });
    expect(globalThis.__membersBoardCalls).toHaveLength(1);
    expect(globalThis.__membersBoardCalls[0].requestId).toBe(RAY);
  });

  it("forwards undefined when locals carries no id", async () => {
    await membersBoardLoad({ url: url(), locals: authedLocals(undefined), cookies, setHeaders });
    expect(globalThis.__membersBoardCalls).toHaveLength(1);
    expect(globalThis.__membersBoardCalls[0].requestId).toBeUndefined();
  });

  it("forwards the helper's request id into the queued board view", async () => {
    await membersBoardLoad({ url: url(), locals: authedLocals(RAY), cookies, setHeaders });
    const queue = globalThis.__membersBoardCalls[0].queueBoardViewFn;
    queue(null, { boardKey: "members", scope: "overall", season: "all", resultCount: 1 }, RAY);
    expect(globalThis.__queueMembersBoardCalls).toHaveLength(1);
    expect(globalThis.__queueMembersBoardCalls[0].requestId).toBe(RAY);
  });

  it("alerts an unseen failure with the binding id and answers 503", async () => {
    globalThis.__membersBoardImpl = async () => {
      throw new TypeError("probe: cannot read properties of undefined");
    };
    const err = await membersBoardLoad({
      url: url(),
      locals: authedLocals(RAY),
      cookies,
      setHeaders,
    }).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(globalThis.__bindingAlertCalls).toHaveLength(1);
    expect(globalThis.__bindingAlertCalls[0].fields).toMatchObject({
      route: "/leaderboards/members",
      requestId: RAY,
    });
  });
});
