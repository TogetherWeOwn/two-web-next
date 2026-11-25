import { env } from "cloudflare:workers";
import { fetchKitStaticText } from "../../../../src/static-public";
import type { RequestEvent } from "@sveltejs/kit";

export async function staticPublicGet({
  request,
  locals,
}: Pick<RequestEvent, "request" | "locals">) {
  return (
    (await fetchKitStaticText(request, env, locals.requestId)) ??
    new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
  );
}
