// One recovery adapter over the shared HTML outcome renderer.
//
// Proves the interface without moving OAuth logic or changing statuses: the
// production recoveryLanding in src/write-recovery.tsx keeps its wiring, and
// this adapter builds the identical model/status/headers through
// renderHtmlOutcome. A future Svelte SSR adapter consumes the same
// RecoveryModel; only the injected renderer changes.
//
// The model carries only safe GET destinations and display copy — never a
// submitted body, never a token — so rendering needs no session or DB merely
// to offer recovery.
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HtmlOutcome, HtmlOutcomeRenderer } from "./html-outcome";

export interface RecoveryModel {
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
  // Validated request ID for the member to quote to support (the same value
  // as the response's x-request-id). Absent on models whose controller never
  // had a request ID to thread; renderers omit the line then.
  supportReference?: string;
}

export interface RecoveryOutcomeOptions {
  status?: ContentfulStatusCode;
  headers?: Record<string, string>;
}

const DEFAULT_HEADERS: Record<string, string> = { "cache-control": "no-store, private" };

/**
 * Build one recovery outcome for the injected renderer. Status stays 200 and
 * the cache header stays private no-store unless the caller overrides both —
 * the adapter never changes the recovery contract, it only changes who
 * renders the bytes.
 */
export function recoveryOutcome(
  model: RecoveryModel,
  renderer: HtmlOutcomeRenderer<RecoveryModel>,
  options?: RecoveryOutcomeOptions,
): HtmlOutcome<RecoveryModel> {
  return {
    model,
    renderer,
    status: options?.status ?? 200,
    headers: options?.headers ?? { ...DEFAULT_HEADERS },
  };
}
