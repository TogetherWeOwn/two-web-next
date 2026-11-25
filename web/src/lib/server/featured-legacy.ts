import { env } from "cloudflare:workers";
import { fetchKitFeaturedLegacy } from "../../../../src/admin/kit-featured-legacy-fetch";

export const featuredLegacy = ({ request, locals }: { request: Request; locals: App.Locals }) =>
  fetchKitFeaturedLegacy(request, env, locals.requestId);
