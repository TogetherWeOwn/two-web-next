// Only the hook can supply the admitted controller for this request.
export const adminFormActions = {
  default: ({ locals }: { locals: App.Locals }) => {
    if (!locals.runAdminForm) throw new Error("Admin form reached without admission");
    return locals.runAdminForm();
  },
};
