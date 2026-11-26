import { env } from "cloudflare:workers";
import type { RequestHandler } from "@sveltejs/kit";
import { fetchKitAdminForm } from "../../../../src/admin/kit-form-fetch";

export const serveAdminRsvpForm: RequestHandler = ({ request, locals }) => {
  if (!locals.requestId) throw new Error("Admin RSVP endpoint reached without admission");
  return fetchKitAdminForm(request, env, null, locals.requestId);
};
