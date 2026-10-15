// Explicit public route slots: the one allowlist of static pages that a
// machine-facing surface may name (sitemap entries, llms.txt links, AI tool
// slots). A public route that is not listed is never advertised, so member,
// admin, draft and API paths cannot reach an index or an assistant by accident.
// Event detail (/e/:key) sits outside this list: the sitemap admits only
// published keys (crawlableEvents in seo.ts).

export type SitemapSlot = { changefreq: string; priority: string };

export const PUBLIC_ROUTE_SLOTS = {
  "/": { changefreq: "weekly", priority: "1.0" },
  "/join": { changefreq: "monthly", priority: "0.9" },
  "/events": { changefreq: "daily", priority: "0.8" },
  "/about": { changefreq: "monthly", priority: "0.7" },
  "/faq": { changefreq: "monthly", priority: "0.7" },
  "/rules": { changefreq: "monthly", priority: "0.7" },
  "/privacy": { changefreq: "monthly", priority: "0.7" },
} as const satisfies Record<string, SitemapSlot>;

export type PublicRoutePath = keyof typeof PUBLIC_ROUTE_SLOTS;

export function isPublicRouteSlot(path: string): path is PublicRoutePath {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ROUTE_SLOTS, path);
}

// A tool calls one public server route and never widens it. Read-only and
// public-only today: a sessionful route or a mutation needs a card that widens
// this type and declares its own auth, same-origin and confirmation contract.
export type ToolSlot = {
  name: string;
  route: PublicRoutePath;
  method: "GET";
  auth: "public";
  confirmation: "none";
};

// Nothing is declared yet, so no tool reaches a page or an assistant.
export const TOOL_SLOTS: readonly ToolSlot[] = [];

export function declareToolSlot(tool: ToolSlot): ToolSlot {
  if (!isPublicRouteSlot(tool.route))
    throw new Error(`tool ${tool.name} targets a route that is not a public slot`);
  if (tool.method !== "GET") throw new Error(`tool ${tool.name} must stay read-only (GET)`);
  if (tool.auth !== "public") throw new Error(`tool ${tool.name} must use public auth`);
  return tool;
}

export function supportedToolSlots(
  tools: readonly ToolSlot[],
  supportsRoute: (route: PublicRoutePath) => boolean,
): ToolSlot[] {
  return tools.filter((tool) => supportsRoute(tool.route));
}
