#!/usr/bin/env node
// Offline machine-contract check (docs/machine-interface.md): the guide, the
// /llms.txt discovery links and the MCP tools/list output schemas must all
// match the canonical public-data contract. Network-free and database-free:
// tools/list runs over an in-memory transport against a null database, so a
// stale guide or a drifting schema fails here the same way in CI and on a
// laptop. Run via `npm run check:machine-contract`; exit 0 on pass, 1 with
// the failing assertions on stdout otherwise. `--format json` prints one
// deterministic receipt instead ({ version, verdict, error_code, next_action,
// failures }) with the same exit codes, bounded to 32 KiB.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { llmsTxt } from "../src/ai-friendly/md";
import {
  communitySnapshotOutputSchema,
  joinHandoffOutputSchema,
  publicApiEventCollectionOutputSchema,
  publicApiEventOutputSchema,
} from "../src/mcp/output-schemas";
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
import { eventResultBytes, fitByteBudget } from "../src/public-data/routes";

const args = process.argv.slice(2);
const jsonMode = args.length === 2 && args[0] === "--format" && args[1] === "json";
if (args.length > 0 && !jsonMode) {
  console.error("check:machine-contract takes no arguments except `--format json`.");
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
// (or a dropped null) fails by name. The payload checks below use the SDK's
// exact zod schemas to catch bounds, formats and other runtime constraints.
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

/** Every canonical field is advertised with the OpenAPI property type, nullability, enum and runtime constraints. */
const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

// Bounds, lengths, patterns and formats that can false-reject a real
// payload when the advertised schema is stricter than OpenAPI. Fixture
// safeParse alone cannot catch these: a title.max(25) mutant keeps a
// 20-char fixture green while the SDK rejects a real 33-char title, so
// the advertised tools/list schema must carry no constraint absent from
// or stricter than the OpenAPI property. additionalProperties and
// descriptions are ignored: they never false-reject exact-key payloads.
const LOWER_BOUNDS = ["minimum", "minLength", "minItems", "minProperties", "minContains"];
const UPPER_BOUNDS = ["maximum", "maxLength", "maxItems", "maxProperties", "maxContains"];
const EXCLUSIVE_LOWER = ["exclusiveMinimum"];
const EXCLUSIVE_UPPER = ["exclusiveMaximum"];
const EXACT_CONSTRAINTS = ["multipleOf", "pattern", "format", "uniqueItems", "enum", "const"];
const CONSTRAINT_KEYS = [
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
  ...EXCLUSIVE_LOWER,
  ...EXCLUSIVE_UPPER,
  ...EXACT_CONSTRAINTS,
];

const pickConstraints = (schema) => {
  const out = {};
  for (const key of CONSTRAINT_KEYS) {
    if (schema?.[key] !== undefined) out[key] = schema[key];
  }
  return out;
};

const isNullBranch = (branch) => {
  const type = branch?.type;
  if (type === "null") return true;
  return Array.isArray(type) && type.length === 1 && type[0] === "null";
};

// Non-null constraint carriers: zod spells a constrained nullable as
// anyOf:[{...constraints},{type:"null"}] but a plain nullable as a type
// array, so collect the wrapper plus every non-null union branch. Stacked
// checks of the same kind (e.g. regex) live in allOf and apply together.
const constraintCarriers = (schema) => {
  if (!schema || typeof schema !== "object") return [];
  const branches = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ].filter((branch) => !isNullBranch(branch));
  if (branches.length === 0) return [pickConstraints(schema)];
  const out = [];
  const top = pickConstraints(schema);
  if (Object.keys(top).length > 0) out.push(top);
  for (const branch of branches) out.push(...constraintCarriers(branch));
  return out;
};

// Loosest possible values: equivalent to the constraint being absent.
const isLoosest = (key, value) => {
  if (key === "minimum") return value === SAFE_INT_MIN;
  if (key === "maximum") return value === SAFE_INT_MAX;
  if (key === "minLength" || key === "minItems" || key === "minProperties" || key === "minContains")
    return value === 0;
  if (key === "uniqueItems") return value === false;
  return false;
};

const pinConstraints = (label, field, advertised, openapi) => {
  // OpenAPI properties in this repo never use anyOf/oneOf: the top-level
  // constraints are the whole reference. A looser advertised schema passes;
  // only absent-from-OpenAPI or stricter fails.
  const reference = pickConstraints(openapi);
  for (const carrier of constraintCarriers(advertised)) {
    for (const [key, value] of Object.entries(carrier)) {
      const openapiValue = reference[key];
      if (openapiValue === undefined) {
        if (isLoosest(key, value)) continue;
        check(
          `${label}.${field} ${key} ${JSON.stringify(value)} is absent from OpenAPI (advertised constraint would reject real payloads)`,
          false,
        );
        continue;
      }
      let stricter;
      if (typeof value === "number" && typeof openapiValue === "number") {
        if ([...LOWER_BOUNDS, ...EXCLUSIVE_LOWER].includes(key)) stricter = value > openapiValue;
        else if ([...UPPER_BOUNDS, ...EXCLUSIVE_UPPER].includes(key))
          stricter = value < openapiValue;
        else stricter = value !== openapiValue;
      } else {
        stricter = JSON.stringify(value) !== JSON.stringify(openapiValue);
      }
      check(
        `${label}.${field} ${key} ${JSON.stringify(value)} is not stricter than OpenAPI ${JSON.stringify(openapiValue)}`,
        !stricter,
      );
    }
  }
};

const pinProperties = (label, advertisedProps, openapiProps, fields) => {
  check(
    `${label} advertises exactly the canonical keys`,
    sameKeys(Object.keys(advertisedProps ?? {}), [...fields]),
  );
  for (const field of fields) {
    const advertised = advertisedProps?.[field];
    const openapi = openapiProps?.[field];
    check(`${label}.${field} is advertised`, advertised !== undefined);
    check(`${label}.${field} exists in OpenAPI`, openapi !== undefined);
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
    pinConstraints(label, field, advertised, openapi);
  }
};

const resolveRef = (doc, schema) => {
  const ref = schema?.$ref;
  if (!ref) return schema;
  let node = doc;
  for (const part of ref.replace(/^#\//, "").split("/")) node = node?.[part];
  return node;
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
check("guide is nonempty", guide.trim().length > 0);
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

// Measured boundary: the 32 KiB ceiling applies to the serialized MCP result
// object (text plus structuredContent, escaping counted); the REST JSON body
// and the JSON-RPC/HTTP transport are distinct. Denylisting wrong phrasings
// cannot keep up with paraphrase, so the guide is compared with the canonical
// text instead: the whole `## Limits` section must equal CANONICAL_LIMITS
// (any edit, deletion or added claim there fails), and no other section may
// state a size, a budget, a cap or a measurement of the result or transport.
// Changing the limits therefore means changing this constant in the same PR.
const CANONICAL_LIMITS = [
  "- Collections cap at 20 rows per response (`per_page` clamps to 20); past-the-end pages clamp to the last page.",
  "- Every event result fits 32 KiB, measured on the serialized MCP `CallToolResult` object: the text content plus the `structuredContent` copy, with string escaping counted. The REST JSON body is the same DTO bytes, so it is smaller. Long descriptions trim with a `…` marker, rows are never dropped; metadata that cannot fit answers `unavailable`.",
  "- The JSON-RPC envelope (the client-chosen request ID, SSE and HTTP framing) is outside that measure and is not bounded by it.",
  "- Events are published-only: drafts and cancelled rows read as not found.",
  "- Unknown counts read as `null`, never `0` (`going_count`, `going_occupancy`, `member_count`, `online_count`).",
].join(" ");
const normalizedGuide = guide.replace(/\r\n/g, "\n");
const flatGuide = normalizedGuide.replace(/\s+/g, " ");
const limitsMatch = /(?:^|\n)## Limits[\t ]*\n([\s\S]*?)(?=\n##[\t ]|$)/.exec(normalizedGuide);
const limitsSection = (limitsMatch?.[1] ?? "").replace(/\s+/g, " ").trim();
check(
  "guide `## Limits` section states the canonical boundary exactly",
  limitsSection === CANONICAL_LIMITS,
);
check(
  "guide has exactly one `## Limits` section",
  (normalizedGuide.match(/^## Limits[\t ]*$/gm) ?? []).length === 1,
);
let outsideLimits = limitsMatch
  ? flatGuide.replace(limitsMatch[0].replace(/\s+/g, " ").trim(), " ")
  : flatGuide;
// Existing parity prose describes equality, not a size boundary.
outsideLimits = outsideLimits.replace("Same DTOs as the MCP tools, byte for byte.", " ");
// A number with a byte unit or the bare ceiling is a size claim on its own.
// Otherwise require both a result/transport subject and a measurement
// predicate. Bare "fits", "bytes", "within" or "counted" can describe schemas,
// field documentation, retry timing or operational counts, not a boundary.
const SIZE_LITERAL = /\b\d[\d,._]*\s*(?:[KMGT]i?B|bytes?|kilobytes?|megabytes?)\b|\b32[ ,_]?768\b/i;
// Bare suffixes stay case-sensitive so "5m" (minutes) is not a size.
const SIZE_BARE_SUFFIX = /\b\d[\d,._]*\s*[kKMGT]\b/;
const RESULT_SUBJECT =
  /\b(?:events?|results?|responses?|replies|reply|payloads?|bod(?:y|ies)|DTOs?|CallToolResult|structuredContent|request\s+IDs?|transport|framing|wrappers?|envelopes?|overhead|text|JSON)\b/i;
// Count nouns need a direct declaration, not unrelated availability/venue prose.
// Only bound qualifiers/abbreviations may precede the numeric count, never
// unrelated suffix text. Direct limit nouns and explicit no-limit claims count too.
// Consume numeric ranges, but not hyphenated attributes or partial numbers.
const COUNT_NUMBER = String.raw`(?:[<>≤≥]=?|=)?\s*[+\-−]?\d+(?:[.,]\d+)*(?:-\d+(?:[.,]\d+)*)?\b(?!-|[.,]\d)`;
// Wrappers must enclose the numeric token, not a phrase such as "8-bit entries".
const COUNT_VALUE = String.raw`(?:${COUNT_NUMBER}|(?:[\[({"'“‘]\s*)+${COUNT_NUMBER}(?:\s*[\])}"'”’])+)`;
const COUNT_BOUNDARY = new RegExp(
  String.raw`\b(?:collections?|rows?|items?)\s+(?:(?:are|is)\s+)?(?:(?:unbounded|unlimited)\b|(?:have|has)\s+no\s+(?:caps?|limits?|bounds?|ceilings?)\b|(?:(?:caps?|capped|limits?|limited|bounds?|bounded)\b|(?:have|has)\s+(?:(?:a|an|the|upper|lower|maximum|minimum|hard|soft|fixed)\s+)*(?:caps?|limits?|bounds?|ceilings?)\b)(?:\s+(?:at|to|of|a|an|the|maximum|minimum|upper|lower|no|more|less|than|only|exactly|up|most|least|e\.g\.|i\.e\.))*\s*(?:[:,]\s*)*${COUNT_VALUE})`,
  "i",
);
const SIZE_PREDICATE =
  /\b(?:siz(?:e|es|ing)|lengths?|budgets?|caps?|capped|limits?|limited|unbounded|unlimited|bounds?|bounded|ceilings?|twice|double[sd]?|duplicat\w*|escap\w*|measur(?:e[sd]?|ing|ements?)|estimat\w*)\b|\b\d+\s*[x×](?=\W|$)/i;
// Abbreviations carry periods that are not sentence ends; rejoin fragments
// split after "e.g."/"i.e." so a subject and its predicate stay in one
// fragment. The original text is kept, so failure messages quote it verbatim.
const rawFragments = outsideLimits.split(/(?<=[.;!?])\s+/);
const outsideSentences = [];
for (const fragment of rawFragments) {
  const prev = outsideSentences[outsideSentences.length - 1];
  if (prev !== undefined && /\b(?:e\.g|i\.e)\.$/i.test(prev.trimEnd()))
    outsideSentences[outsideSentences.length - 1] = `${prev} ${fragment}`;
  else outsideSentences.push(fragment);
}
for (const sentence of outsideSentences) {
  const flat = sentence.trim();
  // Markdown must not hide a count noun, bound predicate or numeric value.
  const countText = flat.replace(/[`*_~]/g, "");
  if (
    flat &&
    (SIZE_LITERAL.test(flat) ||
      SIZE_BARE_SUFFIX.test(flat) ||
      COUNT_BOUNDARY.test(countText) ||
      (RESULT_SUBJECT.test(flat) && SIZE_PREDICATE.test(flat)))
  )
    check(
      `guide states a size or measurement claim outside the canonical Limits: "${flat.slice(0, 80)}"`,
      false,
    );
}

// Real serialization control: 20 maximum-length, escape-heavy descriptions
// must be fitted so the whole typed result, not one DTO copy, is in budget.
// The wrap mirrors the production collection envelope (data plus page, limit
// and meta) so the control cannot under-measure a mini `{data}` wrap.
// Failures here join the receipt instead of throwing past its emitter.
try {
  const dtoRow = (n) => ({
    ...REALISTIC_EVENT,
    event_key: String(n).padStart(26, "0"),
    description: '"\\'.repeat(500),
  });
  const rows = Array.from({ length: 20 }, (_, i) => dtoRow(i + 1));
  const fitted = fitByteBudget(rows, 32768, (trimmed) => ({
    data: trimmed,
    page: 1,
    limit: 20,
    meta: { current_page: 1, per_page: 20, total: 20, last_page: 1 },
  }));
  check(
    "event result fitter bounds the typed result at 32768 bytes",
    eventResultBytes(fitted) <= 32768,
  );
  check("event result fitter keeps every row", JSON.parse(fitted).data.length === 20);
} catch (err) {
  check(`event result fitter control failed: ${err?.message ?? err}`, false);
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
  check(
    `${mention} has a public repository link`,
    body.includes(
      `[${mention}](https://github.com/TogetherWeOwn/two-web-next/blob/main/${mention})`,
    ),
  );
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
    // Use the same exported zod schemas registered with the SDK, not a
    // partial JSON Schema interpreter that silently ignores constraints.
    const expectValid = (label, value, schema) => {
      const result = schema.safeParse(value);
      const problems = result.success
        ? []
        : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      check(
        `${label} validates against the SDK output schema${problems.length ? `: ${problems.join("; ")}` : ""}`,
        result.success,
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
        publicApiEventCollectionOutputSchema,
      );
    }
    if (eventSchema) {
      pinProperties("get_event", eventSchema.properties, schemas.PublicApiEvent.properties, [
        ...PUBLIC_API_EVENT_FIELDS,
      ]);
      expectValid(
        "realistic non-null event vs get_event",
        REALISTIC_EVENT,
        publicApiEventOutputSchema,
      );
      expectValid("all-null event vs get_event", NULLISH_EVENT, publicApiEventOutputSchema);
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
      expectValid(
        "ranks-bearing community vs get_community",
        REALISTIC_COMMUNITY,
        communitySnapshotOutputSchema,
      );
      expectValid(
        "all-null community vs get_community",
        NULLISH_COMMUNITY,
        communitySnapshotOutputSchema,
      );
    }
    if (joinSchema) {
      pinProperties("get_join", joinSchema.properties, schemas.JoinHandoff.properties, [
        ...JOIN_HANDOFF_FIELDS,
      ]);
      expectValid(
        "join handoff vs get_join",
        { intro: "Join us.", invite_url: "https://discord.gg/machine-contract-check" },
        joinHandoffOutputSchema,
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

const MAX_RECEIPT_FAILURES = 50;
const MAX_FAILURE_CHARS = 300;

if (jsonMode) {
  const failed = failures.length > 0;
  // Fixed fields only: no timestamps or request IDs, so repeated runs agree.
  const receipt = (listed) => ({
    version: 1,
    verdict: failed ? "fail" : "pass",
    error_code: failed ? "machine_contract_mismatch" : null,
    next_action: failed
      ? "Fix the listed assertions in docs/machine-interface.md or the MCP contract, then run npm run check:machine-contract again."
      : null,
    failure_count: failures.length,
    failures: listed,
  });
  const listed = failures
    .slice(0, MAX_RECEIPT_FAILURES)
    .map((failure) => String(failure).slice(0, MAX_FAILURE_CHARS));
  // The byte bound is enforced on the exact stdout bytes (the JSON plus the
  // `console.log` newline), so it holds whatever the two caps above are set to.
  while (
    listed.length > 0 &&
    Buffer.byteLength(`${JSON.stringify(receipt(listed))}\n`, "utf8") > 32768
  )
    listed.pop();
  console.log(JSON.stringify(receipt(listed)));
  process.exit(failed ? 1 : 0);
}

if (failures.length > 0) {
  console.log("machine-contract check FAILED:");
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
console.log(
  "machine-contract check passed: guide, llms.txt and 4 advertised output schemas match the canonical contract.",
);
