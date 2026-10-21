// Stateless public read-only MCP server (B2: T1–T4). Four tools over the
// published-only reads, no session, no cookies, no mutations. Tool results
// reuse the REST serializers (src/public-data/routes) so the MCP and REST
// representations cannot drift; test/mcp-public.test.ts pins the tool list,
// the DTO field sets and byte-equality with the REST collection.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { alertRequestError } from "../alerts";
import { readCounts } from "../counts";
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import type { Env } from "../env";
import { getPublicApiEvent, listPublicApiEvents } from "../events/reads";
import {
  API_PUBLIC_BOUNDS,
  PUBLIC_DATA_INTERNAL_MESSAGE,
  parsePublicEventId,
  type PublicApiEventCollectionDto,
  type PublicDataErrorCode,
} from "../public-data/contracts";
import {
  EventByteCapExceededError,
  fitByteBudget,
  serializeCommunity,
  serializeEvent,
  serializeEventCollection,
  serializeJoin,
} from "../public-data/routes";

export const MCP_SERVER_NAME = "two-web-next";
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Exact tool allowlist. T1 lists published events, T2 reads one event, T3
 * reads the community snapshot, T4 reads the Discord join handoff. Nothing
 * here writes: every tool carries readOnlyHint and the server registers no
 * prompts, resources or elicitations.
 */
export const MCP_TOOL_NAMES = ["get_community", "get_event", "get_join", "list_events"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type PublicMcpDeps = {
  env: Env;
  /** Null when no database is configured: event tools report unavailable. */
  db: Db | null;
  /** The HTTP request's validated correlation ID, for error.alert lines. */
  requestId?: string;
};

const READ_ONLY = { readOnlyHint: true } as const;

function toolError(code: PublicDataErrorCode, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true as const,
  };
}

function toolJson(value: object) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

const UNAVAILABLE = "Event data is temporarily unavailable.";
// Programming faults reuse the REST 500 message (same static bytes, same
// privacy boundary); the real error goes to error.alert only.
const INTERNAL = PUBLIC_DATA_INTERNAL_MESSAGE;

export function createPublicMcpServer(deps: PublicMcpDeps): McpServer {
  const { env, db } = deps;
  // Per-request server (see src/mcp/routes.ts), so the closure's request ID
  // is the one on this POST's http.request line: tool failures correlate.
  const internalError = (err: unknown) => {
    alertRequestError(err, { method: "POST", route: "/mcp", requestId: deps.requestId });
    return toolError("internal", INTERNAL);
  };
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    "list_events",
    {
      description:
        "List published community events, soonest first. Read-only: paging clamps to 20 rows per page and long descriptions trim to fit 32 KiB.",
      inputSchema: z.object({
        page: z.number().int().min(1).default(1),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(API_PUBLIC_BOUNDS.maxPageSize)
          .default(API_PUBLIC_BOUNDS.defaultPageSize),
      }),
      annotations: READ_ONLY,
    },
    async ({ page, per_page }) => {
      if (!db) return toolError("unavailable", UNAVAILABLE);
      // A refused socket reads as the unavailable error; programming errors
      // alert and return the static message (the SDK turns a throw into an
      // HTTP 200 isError echoing err.message, so never rethrow here).
      let listed;
      try {
        listed = await listPublicApiEvents(db, {
          limit: per_page,
          offset: (page - 1) * per_page,
        });
      } catch (err: unknown) {
        if (isDatabaseUnavailable(err)) return toolError("unavailable", UNAVAILABLE);
        return internalError(err);
      }
      if (!listed) return toolError("unavailable", UNAVAILABLE);
      const payload: PublicApiEventCollectionDto = serializeEventCollection(
        listed.rows.map(serializeEvent),
        listed.total,
        listed.page,
        per_page,
      );
      // The same byte budget as REST: trim descriptions, never drop rows.
      // Irreducible metadata refuses with the unavailable tool error inside
      // the unchanged JSON-RPC result envelope — never a throw (the SDK
      // echoes err.message) and never an oversized success.
      let body: string;
      try {
        body = fitByteBudget(payload.data, API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => ({
          ...payload,
          data: trimmed,
        }));
      } catch (err) {
        if (err instanceof EventByteCapExceededError) return toolError("unavailable", UNAVAILABLE);
        return internalError(err);
      }
      if (new TextEncoder().encode(body).length > API_PUBLIC_BOUNDS.maxBodyBytes)
        return toolError("unavailable", UNAVAILABLE);
      return toolJson(JSON.parse(body) as Record<string, unknown>);
    },
  );

  server.registerTool(
    "get_event",
    {
      description:
        "Read one published event by its event key. Read-only: drafts, cancelled rows and unknown keys are not found.",
      inputSchema: z.object({ event_key: z.string().min(1).max(64) }),
      annotations: READ_ONLY,
    },
    async ({ event_key }) => {
      // Static message: the rejected key is never reflected.
      if (!parsePublicEventId(event_key))
        return toolError("invalid_request", "That event key is not valid.");
      if (!db) return toolError("unavailable", UNAVAILABLE);
      let row;
      try {
        row = await getPublicApiEvent(db, event_key);
      } catch (err) {
        if (isDatabaseUnavailable(err)) return toolError("unavailable", UNAVAILABLE);
        return internalError(err);
      }
      if (!row) return toolError("not_found", "No published event with that key.");
      let body: string;
      try {
        body = fitByteBudget([serializeEvent(row)], API_PUBLIC_BOUNDS.maxBodyBytes, (t) => t[0]);
      } catch (err) {
        if (err instanceof EventByteCapExceededError) return toolError("unavailable", UNAVAILABLE);
        return internalError(err);
      }
      if (new TextEncoder().encode(body).length > API_PUBLIC_BOUNDS.maxBodyBytes)
        return toolError("unavailable", UNAVAILABLE);
      return toolJson(JSON.parse(body) as Record<string, unknown>);
    },
  );

  server.registerTool(
    "get_community",
    {
      description:
        "Read the public community snapshot: member and online counts (null when unknown, never 0) and per-rank counts. Read-only.",
      annotations: READ_ONLY,
    },
    async () => {
      // readCounts never throws: missing collectors degrade to nulls, never 0.
      // Defensive: a throw still alerts with the static message, never err.message.
      try {
        return toolJson(serializeCommunity(await readCounts(env)));
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "get_join",
    {
      description:
        "Read the Discord join handoff: intro copy and the invite URL. Read-only; joining itself happens in Discord.",
      annotations: READ_ONLY,
    },
    async () => {
      // Database-free like the /join leaf: the handoff is env config only.
      try {
        return toolJson(serializeJoin(env));
      } catch (err) {
        return internalError(err);
      }
    },
  );

  return server;
}
