// Server-only native review markup shared by Hono and Kit load data. Never
// import this renderer into a Svelte page: even csr=false emits client chunks.
export type NativeReviewCopy = {
  summary: string;
  target: string;
  consequence: string;
  keep: string;
  guidance?: string;
  final: string;
};

export type NativeReviewTarget = {
  title: string;
  targetId: string;
  action: string;
  testId?: string;
};

// Svelte's text/attribute escaping rules. Escaping is owned here, before any
// caller passes the resulting trusted markup to raw() or {@html}.
const text = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const attr = (value: string) => text(value).replace(/"/g, "&quot;");
const testIdAttr = (value?: string) => (value ? ` data-testid="${attr(value)}"` : "");

export function renderNativeReviewHtml(
  copy: NativeReviewCopy,
  target: NativeReviewTarget,
  className: "rsvp-review" | "terminal-review",
  reviewTestId?: string,
): string {
  return (
    `<details class="${className}"${testIdAttr(reviewTestId)}>` +
    `<summary aria-label="${attr(`${copy.summary}: ${target.title}`)}">${text(copy.summary)}</summary>` +
    `<p>${text(copy.target)}: <strong>${text(target.title)}</strong></p>` +
    `<p class="${className}-id">ID: ${text(target.targetId)}</p>` +
    `<p>${text(copy.consequence)}</p><p>${text(copy.keep)}</p>` +
    (copy.guidance ? `<p>${text(copy.guidance)}</p>` : "") +
    `<form method="post" action="${attr(target.action)}">` +
    `<button type="submit" class="btn"${testIdAttr(target.testId)}>${text(copy.final)}</button>` +
    `</form></details>`
  );
}

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

export type TerminalReviewTarget = Omit<NativeReviewTarget, "action"> & {
  kind: TerminalReviewKind;
};

/** Endpoint and copy are selected together; callers cannot pair mismatched resources. */
export function renderTerminalReviewHtml({ kind, ...target }: TerminalReviewTarget): string {
  return renderNativeReviewHtml(
    terminalReviewCopy[kind],
    {
      ...target,
      action: `/admin/${kind === "cancel" ? "events" : "featured"}/${target.targetId}/${kind}`,
    },
    "terminal-review",
  );
}

export const rsvpPauseReviewCopy = {
  summary: "Review pause",
  target: "Saved event",
  consequence:
    "Pausing closes signups and freezes the waitlist line. Reopening settles waitlist vacancies.",
  keep: "To keep RSVPs open, close this review using Review pause again. Opening or closing this review changes nothing.",
  final: "Pause RSVPs",
} as const;

/** Server-only HTML shared by Hono and the Kit load model. */
export function renderRsvpPauseReviewHtml(title: string, eventKey: string): string {
  return renderNativeReviewHtml(
    rsvpPauseReviewCopy,
    {
      title,
      targetId: eventKey,
      action: `/admin/events/${eventKey}/rsvp-pause`,
      testId: "rsvp-pause",
    },
    "rsvp-review",
    "rsvp-pause-review",
  );
}
