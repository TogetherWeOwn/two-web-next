import { serveEventWrite } from "#lib/server/event-write.ts";

export const trailingSlash = "ignore";
export const fallback = serveEventWrite;
