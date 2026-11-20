import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

// The Hono controller supplies the admitted display model and owns cache
// policy and journey cookies. Retry and invite links need no client script.
export const csr = false;

export const load: PageServerLoad = ({ locals }) => {
  if (!locals.recovery) error(404);
  return locals.recovery;
};
