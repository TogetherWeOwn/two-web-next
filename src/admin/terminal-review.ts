// Shared presentation copy only; the existing Hono POST endpoints own admission.
export const terminalReviewCopy = {
  cancel: {
    summary: "Review cancellation",
    target: "Saved event",
    consequence:
      "Cancelling is permanent. There is no restore, reopen, republish or unpublish action for this event.",
    keep: "To keep the event, close this review using Review cancellation again. Your unsaved edits stay in the editor.",
    guidance: "",
    final: "Cancel event",
  },
  delete: {
    summary: "Review deletion",
    target: "Saved featured slot",
    consequence: "Deleting removes this featured slot. This cannot be undone.",
    keep: "To keep the slot, close this review using Review deletion again. Your unsaved edits stay in the editor.",
    guidance:
      "To hide the slot without deleting it, clear Published in the editor and Save instead.",
    final: "Delete this slot",
  },
} as const;

export type TerminalReviewKind = keyof typeof terminalReviewCopy;
