// Run from the repo root with node --import tsx ci/fixtures/kit-static-text-local.mjs.
// The hosted fixture additionally exercises Kit's actual route matching and Worker adapter.
import assert from "node:assert/strict";
import app from "../../src/index.tsx";
import { dispatchHookRequest } from "../../src/route-ownership.ts";
import { fetchKitStaticText, KIT_STATIC_TEXT_ROUTES } from "../../src/static-public.ts";
import { assertStaticTextParity } from "./kit-static-text-parity.mjs";

let kit = 0;
let hono = 0;
let sessionReads = 0;
await assertStaticTextParity((request, env) => {
  const url = new URL(request.url);
  const suffix = "/__data.json";
  const isDataRequest = url.pathname.endsWith(suffix);
  if (isDataRequest) url.pathname = url.pathname.slice(0, -suffix.length);
  const route = { id: decodeURI(url.pathname).replace(/\/$/, "") };
  return dispatchHookRequest(
    { request, url, locals: {}, route, isDataRequest },
    {
      appUrl: env.APP_URL,
      apiFamilies: [{ flag: env.KIT_ROUTE_STATIC_TEXT, routes: KIT_STATIC_TEXT_ROUTES }],
      sessionFor: () => {
        sessionReads++;
        throw new Error("Static endpoints must not call the session bridge");
      },
      honoFetch: (original) => {
        assert.equal(original, request);
        hono++;
        return app.fetch(original, env);
      },
      resolve: (event) => {
        kit++;
        return fetchKitStaticText(event.request, env, event.locals.requestId);
      },
    },
  );
});
assert.equal(sessionReads, 0, "static endpoints never called the session bridge");
console.log(
  `PASS static text and vanity synthetic parity (${hono + kit} requests, ${hono} Hono, ${kit} Kit)`,
);
