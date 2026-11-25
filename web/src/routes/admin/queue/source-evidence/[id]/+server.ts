import { env } from "cloudflare:workers";
import { fetchSourceEvidence } from "../../../../../../../src/admin/source-evidence";
import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

const respond: RequestHandler = ({ request, params, locals }) =>
  fetchSourceEvidence(request, env, params.id, locals.requestId);

export {
  respond as GET,
  respond as HEAD,
  respond as POST,
  respond as PUT,
  respond as PATCH,
  respond as DELETE,
  respond as OPTIONS,
};
