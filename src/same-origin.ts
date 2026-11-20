import { createMiddleware } from "hono/factory";
import type { Env } from "./env";
import { jsonRefusal } from "./json-refusal";
import { forbidden, prefersHtmlError, varyAccept } from "./errors";
import { isSameOriginAllowed } from "./http/same-origin";

export { SAME_ORIGIN_EXEMPTIONS, UNSAFE_METHODS } from "./http/same-origin";

export const sameOrigin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (
    !isSameOriginAllowed({
      method: c.req.method,
      path: c.req.path,
      requestUrl: c.req.url,
      get appUrl() {
        return c.env.APP_URL;
      },
      origin: c.req.header("origin"),
      fetchSite: c.req.header("sec-fetch-site"),
    })
  ) {
    c.header("cache-control", "no-store, private");
    varyAccept(c);
    if (prefersHtmlError(c)) return forbidden(c);
    return jsonRefusal(c, "cross_origin", 403);
  }
  return next();
});
