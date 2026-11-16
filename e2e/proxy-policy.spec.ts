import { spawnSync } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Negative controls for the exact-origin Chromium proxy policy configured in
// playwright.config.ts. This spec uses Playwright's own `test` (not ./fixtures),
// so it inherits the real launch args, baseURL and https://localhost:8787
// origin, installs no context.route, and leaves the ordinary-test route guard
// untouched. The page, worker script and redirect come from the real local
// Worker (/__e2e/neg/* in e2e/worker.ts, permissive CSP), so a CSP block or
// route fixture cannot make a probe pass vacuously. Look-alike origins must die
// at the dead proxy, and disposable loopback TCP sinks must see zero browser
// connections. Subresource targets avoid mixed-content by never relying on it:
// the proxy error is asserted from requestfailed, not inferred from a block.
const origin = "https://localhost:8787";
const PROXY_ERROR = "net::ERR_PROXY_CONNECTION_FAILED";
const SEC = 5_000;

type Sink = { port: number; connections: () => number; close: () => Promise<void> };

function startSink(host: string): Promise<Sink | null> {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code ?? "")) {
        resolve(null);
      } else {
        reject(error);
      }
    });
    server.listen(0, host, () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        connections: () => connections,
        close: () =>
          new Promise<void>((done, reject) => {
            const timer = setTimeout(() => reject(new Error(`Sink ${host} did not close`)), SEC);
            for (const socket of sockets) socket.destroy();
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          }),
      }),
    );
  });
}

function probe(port: number, host: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (outcome: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), SEC);
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? "unknown error"));
  });
}

let v4: Sink;
let v6: Sink | null;
let failures: { url: string; error: string }[];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const sink4 = await startSink("127.0.0.1");
  if (!sink4) throw new Error("IPv4 loopback sink could not listen");
  v4 = sink4;
  v6 = await startSink("::1"); // null without IPv6 loopback; see lookalikes()
});

test.afterAll(async () => {
  await Promise.all([v4?.close(), v6?.close()]);
});

test.beforeEach(async ({ context }: { context: BrowserContext }) => {
  failures = [];
  context.on("requestfailed", (request) =>
    failures.push({ url: request.url(), error: request.failure()?.errorText ?? "" }),
  );
});

const sinkConnections = () => v4.connections() + (v6?.connections() ?? 0);
const failedWith = (url: string) =>
  failures.filter((item) => item.url === url).map((item) => item.error);
const openPage = (page: Page) => page.goto(`${origin}/__e2e/neg/page`);

function lookalikes() {
  const v6Port = v6?.port ?? v4.port;
  return [
    // Actual origin with one component changed. Wrong scheme on the real port
    // is observed independently: its failure must be the proxy error.
    "http://localhost:8787/__e2e/neg/page",
    "https://127.0.0.1:8787/__e2e/neg/page",
    "https://[::1]:8787/__e2e/neg/page",
    "https://localhost.:8787/__e2e/neg/page",
    "https://localhost:8788/__e2e/neg/page",
    "https://localhost.invalid:8787/__e2e/neg/page",
    "https://exact-origin.invalid/neg",
    // Wrong-port aliases that reach the live sinks if the policy leaks.
    `http://127.0.0.1:${v4.port}/neg`,
    `https://127.0.0.1:${v4.port}/neg`,
    `http://localhost:${v4.port}/neg`,
    `https://localhost:${v4.port}/neg`,
    `http://localhost.:${v4.port}/neg`,
    `http://[::1]:${v6Port}/neg`,
    `https://[::1]:${v6Port}/neg`,
  ];
}

test("Kit config rejects a default-port origin but accepts a scoped port", () => {
  const list = (kitOrigin: string) =>
    spawnSync(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config=playwright.kit-parity.config.ts",
        "--list",
      ],
      {
        env: { ...process.env, KIT_WORKER_ORIGIN: kitOrigin },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
  const defaultPort = list("http://127.0.0.1");
  expect(defaultPort.status).not.toBe(0);
  expect(defaultPort.stderr).toContain(
    "Kit parity requires an exact local fixture origin with a non-default port",
  );
  const scopedPort = list("http://127.0.0.1:8788");
  expect(scopedPort.status, scopedPort.stderr).toBe(0);
  expect(scopedPort.stdout).toContain("Total:");
});

test("controls: sinks live, proxy dead, exact origin loads", async ({ page }) => {
  // Independent of the browser: plain TCP reaches each sink and nothing
  // listens at the proxy address, so a browser refusal can only be the proxy.
  expect(await probe(v4.port, "127.0.0.1")).toBe("connected");
  await expect.poll(() => v4.connections(), { timeout: SEC }).toBe(1);
  if (v6) {
    const sink = v6;
    expect(await probe(sink.port, "::1")).toBe("connected");
    await expect.poll(() => sink.connections(), { timeout: SEC }).toBe(1);
  }
  await test.info().attach("ipv6-sink", {
    body: v6 ? "available and independently connected" : "unavailable; no IPv6 connection count",
    contentType: "text/plain",
  });
  expect(await probe(9, "127.0.0.1")).toBe("ECONNREFUSED");
  const before = sinkConnections();
  // The configured origin is genuinely bypassed, not merely failing everywhere.
  const response = await openPage(page);
  expect(response?.ok()).toBe(true);
  expect(response?.headers()["content-security-policy"]).toContain("default-src *");
  expect(sinkConnections()).toBe(before);
});

test("top-level navigations to look-alike origins fail at the dead proxy", async ({ page }) => {
  const before = sinkConnections();
  for (const url of lookalikes()) {
    await expect(page.goto(url), url).rejects.toThrow(PROXY_ERROR);
    await expect.poll(() => failedWith(url), { message: url, timeout: SEC }).toContain(PROXY_ERROR);
  }
  expect(sinkConnections()).toBe(before);
});

test("page fetch to look-alike origins is refused by the proxy", async ({ page }) => {
  await openPage(page);
  const before = sinkConnections();
  for (const url of lookalikes()) {
    const outcome = await page.evaluate(
      (target) =>
        fetch(target, { mode: "no-cors" }).then(
          () => "resolved",
          (error: Error) => error.name,
        ),
      url,
    );
    expect(outcome, url).toBe("TypeError");
    await expect.poll(() => failedWith(url), { message: url, timeout: SEC }).toContain(PROXY_ERROR);
  }
  expect(sinkConnections()).toBe(before);
});

test("real redirects from the exact origin die at the proxy", async ({ page }) => {
  // The Worker answers with a genuine 302, so Playwright routing is not
  // involved and only the launch policy can stop the redirected hop.
  const before = sinkConnections();
  for (const target of [
    `http://127.0.0.1:${v4.port}/neg-redirected`,
    "http://redirect.invalid/neg-redirected",
  ]) {
    const hop = `${origin}/__e2e/neg/redirect?to=${encodeURIComponent(target)}`;
    await expect(page.goto(hop), target).rejects.toThrow(PROXY_ERROR);
    expect(failedWith(target), target).toContain(PROXY_ERROR);
  }
  expect(sinkConnections()).toBe(before);
});

test("popup initial navigation to a look-alike origin fails at the proxy", async ({ page }) => {
  await openPage(page);
  const before = sinkConnections();
  const url = `http://127.0.0.1:${v4.port}/neg-popup`;
  const popupPromise = page.waitForEvent("popup", { timeout: SEC });
  await page.evaluate((target) => {
    window.open(target, "_blank");
  }, url);
  await popupPromise;
  await expect.poll(() => failedWith(url), { timeout: SEC }).toContain(PROXY_ERROR);
  expect(sinkConnections()).toBe(before);
});

test("subframe navigation to a look-alike origin fails at the proxy", async ({ page }) => {
  await openPage(page);
  const before = sinkConnections();
  const url = `http://127.0.0.1:${v4.port}/neg-frame`;
  await page.evaluate((target) => {
    const frame = document.createElement("iframe");
    frame.src = target;
    document.body.appendChild(frame);
  }, url);
  await expect.poll(() => failedWith(url), { timeout: SEC }).toContain(PROXY_ERROR);
  expect(sinkConnections()).toBe(before);
});

test("an executing same-origin worker cannot fetch a look-alike origin", async ({ page }) => {
  await openPage(page);
  const before = sinkConnections();
  const url = `http://127.0.0.1:${v4.port}/neg-worker`;
  type Message = { phase: string; ok?: boolean; name?: string };
  const messages = await page.evaluate(
    (target) =>
      new Promise<Message[]>((resolve, reject) => {
        const seen: Message[] = [];
        const worker = new Worker("/__e2e/neg/worker.js");
        const timer = setTimeout(() => reject(new Error("worker did not finish")), 4_000);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = (event) => {
          seen.push(event.data);
          if (event.data.phase === "started") worker.postMessage(target);
          if (event.data.phase === "result") {
            clearTimeout(timer);
            worker.terminate();
            resolve(seen);
          }
        };
      }),
    url,
  );
  // "started" proves the worker script executed; the fetch ran inside it.
  expect(messages).toEqual([
    { phase: "started" },
    { phase: "result", ok: false, name: "TypeError" },
  ]);
  await expect.poll(() => failedWith(url), { timeout: SEC }).toContain(PROXY_ERROR);
  expect(sinkConnections()).toBe(before);
});
