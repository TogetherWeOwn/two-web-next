import { Context } from "hono";
import {
  llmsTxt,
  MARKDOWN_MIME,
  mdAbout,
  mdFaq,
  mdJoin,
  mdPrivacy,
  mdRules,
  STATIC_MD_CACHE,
} from "./ai-friendly/md";
import type { Env } from "./env";
import { internalErrorHandler } from "./errors";
import { stagingRobots } from "./headers";
import { etagFor, matchesIfNoneMatch } from "./http/conditional";
import { safeRequestId } from "./http/request-log";
import { inviteDestination } from "./invite";
import { rulesLastUpdated } from "./rules-last-updated";
import { vanityRedirects } from "./static-leaves";

type Ctx = Context<{ Bindings: Env }>;

// Strong byte validator shared by static and event Markdown. A 304 retains
// the cache policy, robots tag and validator, and carries no body or media type.
export async function mdOk(
  c: Ctx,
  body: string,
  cache: string,
  robots?: string,
): Promise<Response> {
  const tag = robots ?? stagingRobots(c);
  if (tag) c.header("x-robots-tag", tag);
  c.header("cache-control", cache);
  const etag = await etagFor(body, "SHA-1");
  c.header("etag", etag);
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) return c.body(null, 304);
  return c.body(body, 200, { "content-type": MARKDOWN_MIME });
}

export const staticMarkdown = {
  "/llms.txt": (c: Ctx) => mdOk(c, llmsTxt(c.env.APP_URL), STATIC_MD_CACHE),
  "/about.md": (c: Ctx) => mdOk(c, mdAbout(c.env.APP_URL), STATIC_MD_CACHE),
  "/faq.md": (c: Ctx) => mdOk(c, mdFaq(c.env.APP_URL), STATIC_MD_CACHE),
  "/rules.md": (c: Ctx) =>
    mdOk(c, mdRules(c.env.APP_URL, rulesLastUpdated(c.env.RULES_LAST_UPDATED)), STATIC_MD_CACHE),
  "/privacy.md": (c: Ctx) => mdOk(c, mdPrivacy(c.env.APP_URL), STATIC_MD_CACHE),
  "/join.md": (c: Ctx) =>
    mdOk(c, mdJoin(c.env.APP_URL, inviteDestination(c.env.DISCORD_INVITE_URL)), STATIC_MD_CACHE),
};

const handlers = new Map(Object.entries({ ...staticMarkdown, ...vanityRedirects }));

export const KIT_STATIC_TEXT_ROUTES = [...handlers.keys()].map(
  (path) => ({ method: "GET", path, enabled: true, reads: "public" }) as const,
);

// The public endpoint selector owns ingress. Use the same response context
// as the Hono registrations, including query parsing and redirect serialization.
export async function fetchKitStaticText(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = new URL(request.url);
  const handler = handlers.get(pathname);
  if (!handler) return null;
  const c = new Context<{ Bindings: Env }>(request, { env, path: pathname });
  const id = safeRequestId(requestId);
  if (id !== undefined) c.set("requestId", id);
  let response: Response;
  try {
    response = await handler(c);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    response = await internalErrorHandler(error, c, pathname);
  }
  return request.method === "HEAD" ? new Response(null, response) : response;
}
