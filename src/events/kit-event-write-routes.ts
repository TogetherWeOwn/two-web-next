import { EVENT_TRANSITIONS } from "./routes-writes";
const eventActions = [...EVENT_TRANSITIONS, "duplicate"] as const;
function dynamicWrite(method: string, path: string, id: string, pattern: RegExp) {
  return {
    method,
    path,
    enabled: true,
    reads: "public", // The handler admits the body before resolving the session.
    dynamic: {
      id,
      matches: (raw: string, decoded: string) => pattern.test(raw) && pattern.test(decoded),
    },
  } as const;
}

export const KIT_EVENT_WRITE_ROUTES = [
  { method: "POST", path: "/events", enabled: true, reads: "public" },
  dynamicWrite("PATCH", "/events/:key", "/events/[key]", /^\/events\/[^/]+$/),
  dynamicWrite("*", "/events/:key/rsvp", "/events/[key]/rsvp", /^\/events\/[^/]+\/rsvp$/),
  dynamicWrite("POST", "/e/:key/rsvp", "/e/[key]/rsvp", /^\/e\/[^/]+\/rsvp$/),
  ...eventActions.map((action) =>
    dynamicWrite(
      "POST",
      `/events/:key/${action}`,
      "/events/[key]/[action]",
      new RegExp(`^/events/[^/]+/${action}$`),
    ),
  ),
] as const;
