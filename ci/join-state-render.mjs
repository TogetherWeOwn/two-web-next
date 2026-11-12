// Offline rendering of the pinned application's Join fixtures.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appImport, srcImport } from "./join-state-evidence-source.mjs";
import { deriveSnapshot, SCENARIOS, T0, WIDGET_URL } from "./join-state-fixtures.mjs";

const STATES = ["fresh-populated", "stale-populated", "stale-empty", "expired", "fresh-empty"];
const origin = "http://join-state.test";
const inviteUrl = "https://discord.gg/invite";
const MEMBER_NAMES = ["private-member-one", "private-member-two"];

export async function withoutServerNetwork(respond) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected server fetch: ${String(input)}`);
  };
  try {
    return await respond();
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function renderJoinFixtures(appRoot, output, { requestPath = "/join" } = {}) {
  const fixtures = [];
  const { build } = await appImport(appRoot, "esbuild");
  const honoRuntime = await appImport(
    appRoot,
    "hono/jsx/jsx-runtime",
    "node_modules/hono/dist/jsx/jsx-runtime.js",
  );
  const jsx = honoRuntime.jsx ?? honoRuntime.default?.jsx;
  const { createDiscordWidgetHealth, toPublicWidgetSnapshot } = await srcImport(
    appRoot,
    "src/discord-widget.ts",
  );
  const { HOME_JOIN_RESULT_COPY, JOIN_INTRO } = await srcImport(appRoot, "src/home-copy.ts");
  const { Join } = await srcImport(appRoot, "src/screens/join.tsx");

  const scratch = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "join-state-"),
  );
  try {
    const entry = join(scratch, "server.mjs");
    await build({
      stdin: {
        contents: `import { Server } from ${JSON.stringify(join(output, "server/index.js"))};
        import { manifest } from ${JSON.stringify(join(output, "server/manifest.js"))};
        export function fixtureServer(data) {
          const nodes = manifest.nodes.map(load => async () => {
            const node = await load();
            return node.server ? {...node, server: {csr: false, load: () => node.server_id.includes('+layout') ? {} : data()}} : node;
          });
          return new Server({...manifest, nodes});
        }`,
        resolveDir: appRoot,
      },
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      nodePaths: [join(appRoot, "web/node_modules"), join(appRoot, "node_modules")],
      plugins: [
        {
          name: "offline-join-data",
          setup(plugin) {
            plugin.onLoad({ filter: /[/\\]entries[/\\]hooks\.server\.js$/ }, () => ({
              contents: "export const handle = ({event, resolve}) => resolve(event);",
            }));
            plugin.onLoad({ filter: /[/\\]entries[/\\]pages[/\\].*server\.ts\.js$/ }, () => ({
              contents: "export const csr = false; export const load = () => ({});",
            }));
            plugin.onLoad({ filter: /[/\\]entries[/\\]endpoints[/\\]/ }, () => ({
              contents:
                "export const GET = () => { throw new Error('Endpoint outside fixture'); };",
            }));
          },
        },
      ],
      logLevel: "silent",
    });

    let data;
    const { fixtureServer } = await import(pathToFileURL(entry).href);
    const server = fixtureServer(() => data);
    await server.init({ env: {}, read: (file) => readFile(join(output, "client", file)) });

    for (const state of STATES) {
      const {
        primed,
        snapshot,
        widgetUrl: url,
      } = await deriveSnapshot(createDiscordWidgetHealth, state);
      const { channels } = SCENARIOS[state];
      assert.equal(primed?.fetchedAt, T0, "primed at t0");
      assert.equal(url, WIDGET_URL);
      if (state === "expired") {
        assert.equal(snapshot, null, "snapshot drops at max age");
      } else {
        assert.ok(snapshot, `${state} snapshot servable`);
        assert.equal(snapshot.fetchedAt, T0, "fetchedAt never reset");
        assert.equal(snapshot.stale === true, state.startsWith("stale"), `${state} stale flag`);
        assert.equal(snapshot.channels.length, channels.length);
      }
      data = {
        appUrl: origin,
        inviteUrl,
        widgetUrl: url,
        // Same projection and freshness flag the target Kit load returns.
        widgetSnapshot: toPublicWidgetSnapshot(snapshot),
        widgetStale: snapshot?.stale ?? false,
        oneClickHref: "/join/discord",
        joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
        joinResult: null,
        notice: null,
      };
      // Server rendering must never reach the network.
      const response = await withoutServerNetwork(() =>
        server.respond(new Request(origin + requestPath), {
          getClientAddress: () => "127.0.0.1",
        }),
      );
      assert.equal(response.status, 200);
      const kit = await response.text();
      assert.match(kit, /_app\/immutable\/assets\/0\.[^"]+\.css/, "built root stylesheet");
      const hono = jsx(Join, {
        appUrl: origin,
        inviteUrl,
        widgetUrl: url,
        widgetSnapshot: snapshot,
      }).toString();
      for (const html of [kit, hono])
        for (const name of MEMBER_NAMES)
          assert.ok(!html.includes(name), "member names stay off the public page");
      fixtures.push({ name: state, snapshot, widgetUrl: url, kit, hono });
    }

    return { fixtures, scratch };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
