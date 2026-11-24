import { env } from "cloudflare:workers";
import { writeKitProfileEndpoint } from "#lib/server/profile-write.ts";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = ({ request, locals }) =>
  writeKitProfileEndpoint(request, env, locals.requestId);
