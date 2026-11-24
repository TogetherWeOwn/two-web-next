import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const requireKit = createRequire(new URL("../web/package.json", import.meta.url));

// Load the actual Kit hook and Hono Worker entry with only the Cloudflare
// bindings and the framework event replaced. A Kit render fails the fixture.
export async function buildCutoverApps(root) {
  const outfile = join(root, "cutover.mjs");
  const kitPackage = requireKit.resolve("@sveltejs/kit/package.json");
  const kitExports = requireKit(kitPackage).exports;
  await build({
    stdin: {
      contents: `
        export { default as worker } from "./src/worker";
        export { databaseOptions } from "./src/db/connection";
        export { pgEventStore } from "./src/jobs/events";
        export { handle } from "./web/src/hooks.server.ts";
        export { with_request_store } from "@sveltejs/kit/internal/server";
        export { setEnv } from "cloudflare:workers";
      `,
      resolveDir: process.cwd(),
    },
    outfile,
    bundle: true,
    tsconfig: join(process.cwd(), "tsconfig.json"),
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    define: { __TWO_WEB_1033_COMPAT__: "true" },
    plugins: [
      {
        name: "cutover-fixture-bindings",
        setup(bundle) {
          bundle.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "cutover-fixture",
          }));
          bundle.onResolve({ filter: /^#lib\/server\/hono\.ts$/ }, () => ({
            path: join(process.cwd(), "web/src/lib/server/hono.ts"),
          }));
          // The scratch bundle sees only the root node_modules. Keep the
          // pinned Kit hooks and request store in their installed workspace.
          bundle.onResolve(
            { filter: /^@sveltejs\/kit\/(hooks|internal\/server)$/ },
            ({ path }) => ({
              path: join(
                dirname(kitPackage),
                kitExports[path.replace("@sveltejs/kit", ".")].import,
              ),
              external: true,
            }),
          );
          bundle.onLoad({ filter: /^workers$/, namespace: "cutover-fixture" }, () => ({
            contents: `
              export let env;
              export function setEnv(bindings) { env = bindings; }
              export function waitUntil(promise) { void promise; }
            `,
          }));
        },
      },
    ],
  });
  const { worker, handle, setEnv, pgEventStore, databaseOptions, with_request_store } =
    await import(pathToFileURL(outfile).href);
  return {
    databaseOptions,
    pgEventStore,
    apps: [
      {
        sha: "cutover Hono rollback",
        app: { request: (url, init, env) => worker.fetch(new Request(url, init), env) },
      },
      {
        sha: "cutover Kit fallback",
        app: {
          request(url, init, bindings) {
            setEnv({
              ...bindings,
              KIT_ROUTE_ARCHIVE: "false",
              KIT_ROUTE_STATIC: "false",
              KIT_ROUTE_EVENTS: "false",
              KIT_ROUTE_HOME: "false",
              KIT_ROUTE_JOIN: "false",
            });
            const event = {
              request: new Request(url, init),
              url: new URL(url),
              isDataRequest: false,
            };
            // Kit normally creates this request store before invoking handle.
            return with_request_store({ event, state: {} }, () =>
              handle({
                event,
                resolve: () => assert.fail("cutover readiness reached the Kit renderer"),
              }),
            );
          },
        },
      },
    ],
  };
}

// Exercise the live event sync storage state machine under the same serving
// login without running a queue, cron or remote Discord call.
export async function probeCutoverEventSync(pgEventStore, runtime) {
  const eventKey = randomUUID();
  const [event] = await runtime`INSERT INTO events (event_key, title, starts_at, ends_at, status)
    VALUES (${eventKey}, 'Cutover fixture', now(), now() + interval '1 hour', 'published')
    RETURNING id`;
  const store = pgEventStore(runtime);
  const key = randomUUID();
  const now = new Date();
  const prepared = await store.prepareSync(eventKey, key, now);
  assert.equal(prepared?.idempotencyKey, key);
  const claimed = await store.claimSync(prepared, now);
  assert.equal(claimed?.requestAttempts, 1);
  const discordEventId = String(1_000_000_000_000_000_000n + BigInt(event.id));
  await store.completeSync(claimed, discordEventId);
  const [settled] = await runtime`SELECT a.state, e.discord_event_id,
    e.synced_revision = a.revision AS acknowledged
    FROM event_sync_attempts a JOIN events e ON e.id = a.event_id
    WHERE a.idempotency_key = ${key}::uuid`;
  assert.deepEqual(settled, {
    state: "succeeded",
    discord_event_id: discordEventId,
    acknowledged: true,
  });
}
