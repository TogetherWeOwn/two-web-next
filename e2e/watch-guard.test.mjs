import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  installReadOnlyGuard,
  isDiscordWidgetFrame,
  isEdgeBeacon,
  isReadOnlyMethod,
  requireWatchOrigin,
  WATCH_ORIGINS,
} from "./watch-guard.mjs";

test("watch origin guard permits only the three exact origins", () => {
  assert.deepEqual(
    [...WATCH_ORIGINS],
    [
      "https://next.togetherweown.com",
      "https://togetherweown.com",
      "https://www.togetherweown.com",
    ],
  );
  for (const origin of WATCH_ORIGINS) {
    assert.equal(requireWatchOrigin(origin), origin);
    assert.equal(requireWatchOrigin(`${origin}/`), origin);
  }
  for (const raw of [
    undefined,
    "",
    "next.togetherweown.com",
    "http://togetherweown.com/",
    "https://togetherweown.com:8443/",
    "https://user:pass@togetherweown.com/",
    "https://togetherweown.com/events",
    "https://togetherweown.com/?q=x",
    "https://togetherweown.com/#main",
    "https://evil-togetherweown.com/",
    "https://togetherweown.com.example/",
    "https://api.togetherweown.com/",
    "https://staging.togetherweown.com/",
    "https://localhost:8787",
    "https://two-web-next.example.workers.dev/",
  ]) {
    assert.throws(() => requireWatchOrigin(raw), /Watch journeys run only against/);
  }
});

test("only GET and HEAD count as read-only", () => {
  for (const method of ["GET", "HEAD", "get", "Head"]) assert.equal(isReadOnlyMethod(method), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "", undefined]) {
    assert.equal(isReadOnlyMethod(method), false);
  }
});

// A stand-in for a Playwright BrowserContext: records the registered route
// handler so a test can feed it requests the way the browser would.
function fakeContext() {
  const context = {
    pattern: undefined,
    handler: undefined,
    async route(pattern, handler) {
      context.pattern = pattern;
      context.handler = handler;
    },
  };
  return context;
}

function fakeRoute(method, url) {
  const route = {
    continued: false,
    abortedWith: undefined,
    request: () => ({ method: () => method, url: () => url }),
    async continue() {
      route.continued = true;
    },
    async abort(code) {
      route.abortedWith = code;
    },
    fulfilledWith: undefined,
    async fulfill(options) {
      route.fulfilledWith = options;
    },
  };
  return route;
}

test("read guard lets GET and HEAD through and leaves the run clean", async () => {
  const context = fakeContext();
  const guard = await installReadOnlyGuard(context);
  assert.equal(context.pattern, "**/*");
  for (const method of ["GET", "HEAD"]) {
    const route = fakeRoute(method, "https://togetherweown.com/events");
    await context.handler(route);
    assert.equal(route.continued, true);
    assert.equal(route.abortedWith, undefined);
  }
  assert.deepEqual(guard.violations, []);
  assert.doesNotThrow(() => guard.assertClean());
});

test("read guard aborts every non-GET request and fails the test", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const context = fakeContext();
    const guard = await installReadOnlyGuard(context);
    const route = fakeRoute(method, "https://togetherweown.com/e/01ABC/rsvp?token=secret#x");
    await context.handler(route);
    assert.equal(route.continued, false, `${method} must not continue`);
    assert.equal(route.abortedWith, "blockedbyclient", `${method} must be aborted`);
    // The violation names method and path, never the query string.
    assert.deepEqual(guard.violations, [`${method} https://togetherweown.com/e/01ABC/rsvp`]);
    assert.throws(() => guard.assertClean(), /GET-only; blocked 1 write attempt/);
  }
});

test("read guard keeps failing after a write is followed by reads", async () => {
  const context = fakeContext();
  const guard = await installReadOnlyGuard(context);
  await context.handler(fakeRoute("POST", "https://togetherweown.com/csp-reports"));
  await context.handler(fakeRoute("GET", "https://togetherweown.com/"));
  assert.throws(() => guard.assertClean(), /POST https:\/\/togetherweown\.com\/csp-reports/);
});

const RUM = "https://next.togetherweown.com/cdn-cgi/rum?";
const JSD =
  "https://next.togetherweown.com/cdn-cgi/challenge-platform/h/b/jsd/oneshot/d76008a69eab/0.33:1791126314:abc/a4554893c81ceae0";
const DISCORD_JSD =
  "https://discord.com/cdn-cgi/challenge-platform/h/b/jsd/oneshot/d76008a69eab/0.33:1791126314:abc/a45548964d3e0056";
const WIDGET = "https://discord.com/widget?id=1545644954272137297&theme=dark";

test("Cloudflare edge beacons are stubbed locally, never sent and never a violation", async () => {
  const context = fakeContext();
  const guard = await installReadOnlyGuard(context);
  for (const url of [RUM, JSD, "https://togetherweown.com/cdn-cgi/rum"]) {
    const route = fakeRoute("POST", url);
    await context.handler(route);
    assert.equal(route.continued, false, `${url} must not reach the network`);
    assert.equal(route.abortedWith, undefined, `${url} must not be an abort`);
    assert.deepEqual(route.fulfilledWith, { status: 204 });
  }
  assert.deepEqual(guard.violations, []);
  assert.doesNotThrow(() => guard.assertClean());
  // The report still names each stubbed beacon (method and path, no query).
  assert.equal(guard.stubbedBeacons.length, 3);
  assert.equal(guard.stubbedBeacons[0], "POST https://next.togetherweown.com/cdn-cgi/rum");
  for (const entry of guard.stubbedBeacons) assert.doesNotMatch(entry, /\?/);
});

test("the beacon carve-out is exact: any other write still aborts and fails", async () => {
  for (const [method, url] of [
    // Right path, wrong method.
    ["PUT", RUM],
    ["DELETE", JSD],
    // Dot-segment and encoded-dot-segment escapes out of /cdn-cgi/.
    ["POST", "https://next.togetherweown.com/cdn-cgi/challenge-platform/../api/rsvp"],
    ["POST", "https://next.togetherweown.com/cdn-cgi/challenge-platform/%2e%2e/api/rsvp"],
    // Near misses on the exact path and on the prefix.
    ["POST", "https://next.togetherweown.com/cdn-cgi/rum/extra"],
    ["POST", "https://next.togetherweown.com/cdn-cgi/rumble"],
    ["POST", "https://next.togetherweown.com/cdn-cgi/challenge-platform"],
    ["POST", "https://next.togetherweown.com/cdn-cgi/trace"],
    ["POST", "https://next.togetherweown.com/e/01ABC/rsvp"],
    ["POST", "https://next.togetherweown.com/csp-reports"],
    // Other hosts: only the three watch origins. Discord's own beacon is not
    // stubbed either: its widget frame is, so that script never runs.
    ["POST", DISCORD_JSD],
    ["POST", "https://discord.com/api/v10/channels/1/messages"],
    ["POST", "https://discord.com/cdn-cgi/rum"],
    ["POST", "https://evil.example/cdn-cgi/rum"],
    ["POST", "https://togetherweown.com.evil.example/cdn-cgi/rum"],
    ["POST", "https://api.togetherweown.com/cdn-cgi/rum"],
    ["POST", "http://togetherweown.com/cdn-cgi/rum"],
    ["POST", "not a url"],
  ]) {
    assert.equal(isEdgeBeacon(method, url), false, `${method} ${url} must not be a beacon`);
    const context = fakeContext();
    const guard = await installReadOnlyGuard(context);
    const route = fakeRoute(method, url);
    await context.handler(route);
    assert.equal(route.fulfilledWith, undefined, `${method} ${url} must not be stubbed`);
    assert.equal(route.abortedWith, "blockedbyclient", `${method} ${url} must be aborted`);
    assert.throws(() => guard.assertClean(), /GET-only; blocked 1 write attempt/);
  }
});

test("Discord's widget frame is answered locally, never fetched and never a failure", async () => {
  const context = fakeContext();
  const guard = await installReadOnlyGuard(context);
  const route = fakeRoute("GET", WIDGET);
  await context.handler(route);
  assert.equal(route.continued, false, "the widget frame must not reach Discord");
  assert.equal(route.abortedWith, undefined);
  assert.equal(route.fulfilledWith.status, 200);
  assert.match(route.fulfilledWith.contentType, /^text\/html\b/);
  assert.deepEqual(guard.violations, []);
  assert.doesNotThrow(() => guard.assertClean());
  // Method and path only; the guild id in the query is not echoed.
  assert.deepEqual(guard.stubbedFrames, ["GET https://discord.com/widget"]);
  assert.deepEqual(guard.stubbedBeacons, []);
});

test("the widget-frame carve-out is exact: everything else on discord.com is read or refused as before", async () => {
  for (const [method, url] of [
    // Right URL, wrong method: a write is never a widget frame.
    ["POST", WIDGET],
    ["PUT", WIDGET],
    // Near misses on the host and the path.
    ["GET", "https://discord.com/widget/extra"],
    ["GET", "https://discord.com/widgets"],
    ["GET", "https://discord.com/api/guilds/1545644954272137297/widget.json"],
    ["GET", "https://discord.com/widget/../api/v10/users/@me"],
    ["GET", "https://discord.com/widget/%2e%2e/api/v10/users/@me"],
    ["GET", "https://canary.discord.com/widget?id=1"],
    ["GET", "https://discord.com.evil.example/widget?id=1"],
    ["GET", "http://discord.com/widget?id=1"],
    ["GET", "https://togetherweown.com/widget"],
    ["GET", "not a url"],
  ]) {
    assert.equal(isDiscordWidgetFrame(method, url), false, `${method} ${url} is not the frame`);
  }
  assert.equal(isDiscordWidgetFrame("get", WIDGET), true);
  // Anything that is not the frame keeps its old handling: reads pass through.
  const context = fakeContext();
  const guard = await installReadOnlyGuard(context);
  const read = fakeRoute("GET", "https://discord.com/api/guilds/1/widget.json");
  await context.handler(read);
  assert.equal(read.continued, true);
  assert.equal(read.fulfilledWith, undefined);
  assert.deepEqual(guard.stubbedFrames, []);
  // ...and a write to the widget URL is still aborted and fails the run.
  const write = fakeRoute("POST", WIDGET);
  await context.handler(write);
  assert.equal(write.abortedWith, "blockedbyclient");
  assert.equal(write.fulfilledWith, undefined);
  assert.throws(() => guard.assertClean(), /blocked 1 write attempt/);
});

test("a beacon does not mask a real write in the same run", async () => {
  const context = fakeContext();
  const guard = await installReadOnlyGuard(context);
  await context.handler(fakeRoute("POST", RUM));
  await context.handler(fakeRoute("POST", "https://togetherweown.com/e/01ABC/rsvp"));
  await context.handler(fakeRoute("POST", JSD));
  assert.equal(guard.stubbedBeacons.length, 2);
  assert.deepEqual(guard.violations, ["POST https://togetherweown.com/e/01ABC/rsvp"]);
  assert.throws(() => guard.assertClean(), /blocked 1 write attempt/);
});

test("watch config stays guest-only and out of the default project", () => {
  const config = readFileSync(new URL("../playwright.watch.config.ts", import.meta.url), "utf8");
  assert.match(config, /requireGithubRunner\(\)/);
  assert.match(config, /requireWatchOrigin\(process\.env\.WATCH_ORIGIN\)/);
  assert.match(config, /storageState:\s*\{\s*cookies:\s*\[\],\s*origins:\s*\[\]\s*\}/);
  assert.doesNotMatch(config, /\.auth\//);
  // The default project would run the spec against the local wrangler dev
  // Worker, so it must ignore e2e/watch like it ignores e2e/staging.
  const defaultConfig = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  assert.match(defaultConfig, /testIgnore:\s*"[^"]*watch[^"]*"/);
});

test("watch spec never signs in or writes", () => {
  const spec = readFileSync(new URL("./watch/guest-journeys.spec.ts", import.meta.url), "utf8");
  for (const forbidden of [
    /\.click\(/,
    /\.fill\(/,
    /\.type\([^)]/, // locator.type(text); message.type() is a read
    /\.press\(/,
    /\.submit\(/,
    /\.(post|put|patch|delete)\(/,
    /\bfetch\(|XMLHttpRequest|sendBeacon/,
    /storageState/,
    /QA_AUTH_TOKEN/,
    /\/auth\//,
  ]) {
    assert.doesNotMatch(spec, forbidden);
  }
});
