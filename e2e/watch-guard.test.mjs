import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  installReadOnlyGuard,
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
