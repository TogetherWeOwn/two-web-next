import { env } from "cloudflare:workers";
import { fetchOpsOverrides } from "../../../../../src/admin/ops-overrides-fetch";
import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

const respond: RequestHandler = async ({ request }) => {
  const response = await fetchOpsOverrides(request, env);
  if (!response) throw new Error("operator adapter did not handle admitted method");
  return response;
};

export {
  respond as GET,
  respond as HEAD,
  respond as POST,
  respond as PUT,
  respond as PATCH,
  respond as DELETE,
  respond as OPTIONS,
};
