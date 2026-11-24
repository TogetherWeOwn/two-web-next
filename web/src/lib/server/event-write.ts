import { env } from "cloudflare:workers";
import { fetchKitEventWrite } from "../../../../src/events/kit-event-write-fetch";

export async function serveEventWrite({
  request,
  locals,
}: {
  request: Request;
  locals: App.Locals;
}) {
  const response = await fetchKitEventWrite(request, env, locals.requestId);
  if (!response) return new Response(null, { status: 404 });
  return response;
}
