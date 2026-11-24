import { error, redirect } from "@sveltejs/kit";

// The hook admits the exact method/path and session before Kit can invoke
// this action. The controller owns the HTTP response, including validation
// HTML and recovery cookies. Redirect short-circuits Kit's follow-up loads;
// the hook returns the captured response in its place.
export const adminFormActions = {
  default: async ({ locals }: { locals: App.Locals }) => {
    if (!locals.runAdminForm) error(404);
    await locals.runAdminForm();
    redirect(303, "/admin");
  },
};
