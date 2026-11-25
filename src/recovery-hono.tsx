// Hono JSX adapter over the shared HTML outcome renderer.
//
// Controllers that return HTML recovery outcomes (GET /auth/recover, the
// /join/callback recover() paths) build a RecoveryModel and render it through
// renderHtmlOutcome with this adapter, instead of calling c.html() directly.
// The bytes, statuses, headers and cookie writes are unchanged — only who
// renders the bytes changes. A Svelte SSR adapter consumes the same model
// (web/src/lib/Recovery.svelte); only the injected renderer differs.
import { renderHtmlOutcome } from "./html-outcome";
import type { JoinRender } from "./join/route-shared";
import { Recovery } from "./pages";
import { type RecoveryModel, recoveryOutcome } from "./recovery-outcome";
import { safeRequestId } from "./request-log";

/** Render one recovery model to Hono JSX bytes (buffered by the caller). */
export const honoRecoveryRenderer = (model: RecoveryModel) => (
  <Recovery
    title={model.title}
    message={model.message}
    retryUrl={model.retryUrl}
    retryLabel={model.retryLabel}
    inviteUrl={model.inviteUrl}
    supportReference={model.supportReference}
  />
);

export const renderJoinRecovery: JoinRender["recovery"] = (c, props, status = 200) =>
  renderHtmlOutcome(
    c,
    recoveryOutcome(
      { ...props, supportReference: safeRequestId(c.get("requestId")) },
      honoRecoveryRenderer,
      { status },
    ),
  );
