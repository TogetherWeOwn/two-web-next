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
  COMMUNITY_RANK_FIELDS,
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

// Property-type pinning: zod spells nullable strings as {type:["string",
// "null"]} but nullable integers as {anyOf:[{type:"integer"...},
// {type:"null"}]}, while OpenAPI spells both as type arrays. Normalize
// both sides to base types plus a null flag, so a drifted property type
// (or a dropped null) fails by name. Formats, descriptions and integer
// bounds stay unchecked: they describe the same values and must never
// false-reject a real payload.
const collectTypes = (schema, into) => {
  if (!schema) return;
  for (const t of Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []) {
    into.add(t);
  }
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    collectTypes(branch, into);
  }
};

const normalizeType = (schema) => {
  const found = new Set();
  collectTypes(schema, found);
  const nullable = found.delete("null");
  return { types: [...found].sort(), nullable };
};

const sameTypeShape = (a, b) => {
  const left = normalizeType(a);
  const right = normalizeType(b);
  return (
    JSON.stringify(left.types) === JSON.stringify(right.types) && left.nullable === right.nullable
  );
};

const typeShapeText = (schema) => {
  const shape = normalizeType(schema);
  return `${shape.types.join("|") || "?"}${shape.nullable ? "|null" : ""}`;
};

/** Every canonical field is advertised with the OpenAPI property type, nullability and enum. */
const pinProperties = (label, advertisedProps, openapiProps, fields) => {
  check(
    `${label} advertises exactly the canonical keys`,
    sameKeys(Object.keys(advertisedProps ?? {}), [...fields]),
  );
  for (const field of fields) {
    const advertised = advertisedProps?.[field];
    const openapi = openapiProps?.[field];
    check(`${label}.${field} is advertised`, advertised !== undefined);
    if (!advertised || !openapi) continue;
    check(
      `${label}.${field} type matches OpenAPI (advertised ${typeShapeText(advertised)} vs openapi ${typeShapeText(openapi)})`,
      sameTypeShape(advertised, openapi),
    );
    if (openapi.enum) {
      check(
        `${label}.${field} enum matches OpenAPI`,
        JSON.stringify([...(advertised.enum ?? [])].sort()) ===
          JSON.stringify([...openapi.enum].sort()),
      );
    }
  }
};

const resolveRef = (doc, schema) => {
  const ref = schema?.$ref;
  if (!ref) return schema;
  let node = doc;
  for (const part of ref.replace(/^#\//, "").split("/")) node = node?.[part];
  return node;
};

// Minimal JSON Schema conformance check (type, required, properties,
// items, enum, const, anyOf, oneOf), mirroring the acceptance suite's
// validator so realistic payloads prove the advertised schemas accept
// real serializer shapes. Unknown keywords are ignored.
const matchesJsonType = (value, type) => {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
};

const validateJson = (value, schema, path = "$") => {
  const problems = [];
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const))
      problems.push(`${path} is not the const`);
    return problems;
  }
  if (schema.enum) {
    if (!schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
      problems.push(`${path} not in enum`);
    return problems;
  }
  for (const key of ["anyOf", "oneOf"]) {
    const branches = schema[key];
    if (branches) {
      if (!branches.some((branch) => validateJson(value, branch, path).length === 0))
        problems.push(`${path} matches no ${key} branch`);
      return problems;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    problems.push(`${path} is not ${types.join("|")}`);
    return problems;
  }
  const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if ((types.includes("object") || (!schema.type && schema.properties)) && isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) problems.push(`${path}.${name} is missing`);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (name in value) problems.push(...validateJson(value[name], property, `${path}.${name}`));
    }
  }
  if (types.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      problems.push(...validateJson(item, schema.items, `${path}[${index}]`)),
    );
  }
  return problems;
};

// Serializer-shaped payloads exercising every type branch the fixtures
// miss: non-null game/location/capacity, live community counts and a
// ranks-bearing snapshot including a null rank count.
const REALISTIC_EVENT = {
  event_key: "00000000000000000000000001",
  title: "Friday Night Bracket",
  game: "Melee",
  description: "Weekly bracket, all skill levels.",
  starts_at: "2099-01-02T20:00:00.000Z",
  ends_at: "2099-01-02T22:00:00.000Z",
  starts_at_local: "2099-01-02 20:00",
  ends_at_local: "2099-01-02 22:00",
  timezone: "America/New_York",
  location: "The Loft",
  capacity: 50,
  going_count: 12,
  going_occupancy: 12,
  status: "published",
  rsvp_open: true,
  synced_to_discord: false,
};

const NULLISH_EVENT = {
  ...REALISTIC_EVENT,
  game: null,
  description: null,
  location: null,
  capacity: null,
  going_count: null,
  going_occupancy: null,
};

const REALISTIC_COMMUNITY = {
  member_count: 1234,
  online_count: 56,
  ranks: [
    { key: "member", label: "Member", member_count: null },
    { key: "moderator", label: "Moderator", member_count: 3 },
  ],
};

const NULLISH_COMMUNITY = { member_count: null, online_count: null, ranks: [] };

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
    const openapiDoc = getOpenApiDocument(APP_URL);
    const schemas = openapiDoc.components.schemas;
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
    // Deep type pinning: every advertised property — including the nested
    // collection rows, paging meta and community ranks — matches the
    // OpenAPI property type, nullability and enum. Required-key checks
    // alone let a drifted type through while the SDK rejects real
    // payloads, so each property fails by name here.
    const expectValid = (label, value, schema) => {
      const problems = schema ? validateJson(value, schema) : ["missing schema"];
      check(
        `${label} validates against the advertised schema${problems.length ? `: ${problems.join("; ")}` : ""}`,
        problems.length === 0,
      );
    };
    if (listSchema) {
      const collectionProps = schemas.PublicApiEventCollection.properties;
      pinProperties("list_events", listSchema.properties, collectionProps, [
        ...PUBLIC_API_COLLECTION_FIELDS,
      ]);
      const rows = listSchema.properties?.data;
      check("list_events.data is an array", rows?.type === "array");
      const rowOpenapi = resolveRef(openapiDoc, collectionProps?.data?.items);
      pinProperties("list_events.data[]", rows?.items?.properties, rowOpenapi?.properties, [
        ...PUBLIC_API_EVENT_FIELDS,
      ]);
      pinProperties(
        "list_events.meta",
        listSchema.properties?.meta?.properties,
        collectionProps?.meta?.properties,
        [...PUBLIC_API_META_FIELDS],
      );
      expectValid(
        "realistic collection vs list_events",
        {
          data: [REALISTIC_EVENT],
          page: 1,
          limit: 20,
          meta: { current_page: 1, per_page: 20, total: 1, last_page: 1 },
        },
        listSchema,
      );
    }
    if (eventSchema) {
      pinProperties("get_event", eventSchema.properties, schemas.PublicApiEvent.properties, [
        ...PUBLIC_API_EVENT_FIELDS,
      ]);
      expectValid("realistic non-null event vs get_event", REALISTIC_EVENT, eventSchema);
      expectValid("all-null event vs get_event", NULLISH_EVENT, eventSchema);
    }
    if (communitySchema) {
      const snapshotProps = schemas.CommunitySnapshot.properties;
      pinProperties("get_community", communitySchema.properties, snapshotProps, [
        ...COMMUNITY_SNAPSHOT_FIELDS,
      ]);
      const ranks = communitySchema.properties?.ranks;
      check("get_community.ranks is an array", ranks?.type === "array");
      const rankOpenapi = resolveRef(openapiDoc, snapshotProps?.ranks?.items);
      check(
        "get_community.ranks[] required matches OpenAPI",
        sameKeys(ranks?.items?.required, rankOpenapi?.required),
      );
      check(
        "get_community.ranks[] required matches the canonical rank fields",
        sameKeys(ranks?.items?.required, [...COMMUNITY_RANK_FIELDS]),
      );
      pinProperties("get_community.ranks[]", ranks?.items?.properties, rankOpenapi?.properties, [
        ...COMMUNITY_RANK_FIELDS,
      ]);
      expectValid("ranks-bearing community vs get_community", REALISTIC_COMMUNITY, communitySchema);
      expectValid("all-null community vs get_community", NULLISH_COMMUNITY, communitySchema);
    }
    if (joinSchema) {
      pinProperties("get_join", joinSchema.properties, schemas.JoinHandoff.properties, [
        ...JOIN_HANDOFF_FIELDS,
      ]);
      expectValid(
        "join handoff vs get_join",
        { intro: "Join us.", invite_url: "https://discord.gg/machine-contract-check" },
        joinSchema,
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
