#!/usr/bin/env node
// Offline machine-contract check (docs/machine-interface.md): the guide, the
// /llms.txt discovery links and the MCP tools/list output schemas must all
// match the canonical public-data contract. Network-free and database-free:
// tools/list runs over an in-memory transport against a null database, so a
// stale guide or a drifting schema fails here the same way in CI and on a
// laptop. Run via `npm run check:machine-contract`; exit 0 on pass, 1 with
// the failing assertions on stdout otherwise.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { llmsTxt } from "../src/ai-friendly/md";
import { MCP_TOOL_NAMES, createPublicMcpServer } from "../src/mcp/server";
import {
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  PUBLIC_API_COLLECTION_FIELDS,
  PUBLIC_API_EVENT_FIELDS,
  PUBLIC_API_META_FIELDS,
} from "../src/public-data/contracts";
import { getOpenApiDocument } from "../src/public-data/openapi";

if (process.argv.length > 2) {
  console.error("check:machine-contract takes no arguments.");
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const APP_URL = "https://machine-contract-check.local";
const failures = [];

const check = (name, ok) => {
  if (!ok) failures.push(name);
};

const sorted = (fields) => [...(fields ?? [])].sort();
const sameKeys = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const allowsNull = (schema) => {
  if (!schema) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("null")) return true;
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some(allowsNull);
};

const guidePath = `${repoRoot}docs/machine-interface.md`;
check("guide docs/machine-interface.md exists", existsSync(guidePath));
const guide = existsSync(guidePath) ? readFileSync(guidePath, "utf8") : "";
if (guide) {
  check("guide stays short (<=120 lines)", guide.split("\n").length <= 120);
  for (const code of ["invalid_request", "not_found", "rate_limited", "unavailable", "internal"]) {
    check(`guide names ${code}`, guide.includes(code));
  }
  check("guide states the 20 rows cap", /20\s+rows/.test(guide));
  check("guide states the 32 KiB cap", guide.includes("32 KiB"));
  check("guide names Retry-After", /retry-after/i.test(guide));
  check("guide names a next action", /try again/i.test(guide));
  check("guide links /mcp", guide.includes("/mcp"));
  check("guide links /openapi.json", guide.includes("/openapi.json"));
  check(
    "guide names npm run check:machine-contract",
    guide.includes("npm run check:machine-contract"),
  );
}

const body = llmsTxt(APP_URL);
check("llms.txt links /mcp", body.includes(`${APP_URL}/mcp`));
check("llms.txt links /openapi.json", body.includes(`${APP_URL}/openapi.json`));
for (const name of MCP_TOOL_NAMES) check(`llms.txt names ${name}`, body.includes(name));
check("llms.txt says read-only", /read-only/i.test(body));
check("llms.txt keeps sign-in in the browser", /browser/i.test(body));
check("llms.txt drops no-remote-tools", !body.includes("no remote tools"));
check("llms.txt stays silent on training", !/training/i.test(body));
check("llms.txt has no member directory", !/member directory/i.test(body));
for (const link of [...body.matchAll(/https?:\/\/[^\s)>\]"']+/g)]
  .map((match) => match[0].replace(/[.,;:]+$/, ""))
  .filter((candidate) => candidate.startsWith(`${APP_URL}/`))) {
  check(
    `discovery link ${link} is not auth surface`,
    !/oauth|authorize|\/token|login|session|admin/i.test(link),
  );
}
const mentions = [
  ...new Set([...body.matchAll(/(?<![\w/.])docs\/[a-z0-9-]+\.md/g)].map((match) => match[0])),
];
check(
  "llms.txt points to exactly docs/machine-interface.md",
  JSON.stringify(mentions) === JSON.stringify(["docs/machine-interface.md"]),
);
for (const mention of mentions) {
  check(`${mention} resolves to a repo file`, existsSync(`${repoRoot}${mention}`));
}

const rpc = async () => {
  const server = createPublicMcpServer({
    env: { APP_URL, DISCORD_INVITE_URL: "https://discord.gg/machine-contract-check" },
    db: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  clientTransport.onmessage = (message) => {
    const id = message?.id;
    if (id !== undefined && pending.has(id)) {
      pending.get(id)(message);
      pending.delete(id);
    }
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      clientTransport
        .send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
        .catch((err) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        });
    });
  try {
    const hello = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "check-machine-contract", version: "0" },
    });
    check("MCP initialize answers", hello?.result !== undefined && hello?.error === undefined);
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await call("tools/list", {});
    const tools = listed?.result?.tools ?? [];
    check(
      "tools/list names the four read-only tools",
      sameKeys(
        tools.map((tool) => tool.name),
        [...MCP_TOOL_NAMES],
      ),
    );
    const schemas = getOpenApiDocument(APP_URL).components.schemas;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of MCP_TOOL_NAMES) {
      check(`tools/list advertises ${name}`, byName[name] !== undefined);
      check(`${name} keeps readOnlyHint`, byName[name]?.annotations?.readOnlyHint === true);
      const schema = byName[name]?.outputSchema;
      check(`${name} advertises outputSchema`, schema !== undefined);
      check(
        `${name} outputSchema is a nonempty object`,
        schema?.type === "object" &&
          Object.keys(schema?.properties ?? {}).length > 0 &&
          (schema?.required ?? []).length > 0,
      );
    }
    const listSchema = byName.list_events?.outputSchema;
    if (listSchema) {
      check(
        "list_events required matches OpenAPI",
        sameKeys(listSchema.required, schemas.PublicApiEventCollection.required),
      );
      check(
        "list_events required matches the canonical envelope",
        sameKeys(listSchema.required, [...PUBLIC_API_COLLECTION_FIELDS]),
      );
      check(
        "list_events rows match the canonical event fields",
        sameKeys(listSchema.properties?.data?.items?.required, [...PUBLIC_API_EVENT_FIELDS]),
      );
      check(
        "list_events meta matches the canonical cursor",
        sameKeys(listSchema.properties?.meta?.required, [...PUBLIC_API_META_FIELDS]),
      );
    }
    const eventSchema = byName.get_event?.outputSchema;
    if (eventSchema) {
      check(
        "get_event required matches the canonical event fields",
        sameKeys(eventSchema.required, [...PUBLIC_API_EVENT_FIELDS]),
      );
      check(
        "get_event required matches OpenAPI",
        sameKeys(eventSchema.required, schemas.PublicApiEvent.required),
      );
      for (const field of [
        "going_count",
        "going_occupancy",
        "game",
        "description",
        "location",
        "capacity",
      ]) {
        check(`get_event.${field} allows null`, allowsNull(eventSchema.properties?.[field]));
      }
      const status = eventSchema.properties?.status;
      check(
        "get_event.status pins published",
        status?.enum?.includes("published") || status?.const === "published",
      );
    }
    const communitySchema = byName.get_community?.outputSchema;
    if (communitySchema) {
      check(
        "get_community required matches the canonical snapshot",
        sameKeys(communitySchema.required, [...COMMUNITY_SNAPSHOT_FIELDS]),
      );
      check(
        "get_community required matches OpenAPI",
        sameKeys(communitySchema.required, schemas.CommunitySnapshot.required),
      );
      for (const field of ["member_count", "online_count"]) {
        check(
          `get_community.${field} allows null`,
          allowsNull(communitySchema.properties?.[field]),
        );
      }
    }
    const joinSchema = byName.get_join?.outputSchema;
    if (joinSchema) {
      check(
        "get_join required matches the canonical handoff",
        sameKeys(joinSchema.required, [...JOIN_HANDOFF_FIELDS]),
      );
      check(
        "get_join required matches OpenAPI",
        sameKeys(joinSchema.required, schemas.JoinHandoff.required),
      );
    }
  } finally {
    await clientTransport.close().catch(() => {});
  }
};

try {
  await rpc();
} catch (err) {
  failures.push(`MCP in-memory tools/list failed: ${err?.message ?? err}`);
}

if (failures.length > 0) {
  console.log("machine-contract check FAILED:");
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
console.log(
  "machine-contract check passed: guide, llms.txt and 4 advertised output schemas match the canonical contract.",
);
