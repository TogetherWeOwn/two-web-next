import { jsonRead } from "#lib/server/event-reads.ts";
import { KIT_EVENT_COLLECTION_ROUTE } from "../../../../src/events/kit-json-routes";
import { eventCollectionJson } from "../../../../src/events/routes-json";
import { readContextSession } from "../../../../src/session-hono";

export { trailingSlash } from "#lib/server/event-reads.ts";

export const prerender = false;

export const GET = jsonRead(KIT_EVENT_COLLECTION_ROUTE.path, (c) =>
  eventCollectionJson(c, (context) => readContextSession(context, false)),
);
