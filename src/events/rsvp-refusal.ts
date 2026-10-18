// RSVP refusal outcome over the shared HTML outcome renderer.
//
// The no-JS POST /e/:key/rsvp adapter refuses writes that the locked service
// already decided (closed event, throttled member, database outage) with a
// branded page inside the event shell. The controller supplies this typed
// model, the refusal status and the extra headers; the injected renderer turns
// the model into bytes exactly once per outcome object, so a re-read never
// double-renders and never re-executes the mutation. Framework-free: the core
// never imports Hono JSX or Svelte. The Hono adapter lives in
// ./rsvp-refusal-hono; a future Svelte SSR adapter consumes the same model and
// only the injected renderer changes.
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RSVP_COPY, throttleWaitCopy } from "../islands/contracts-rsvp-button";
import type { HtmlOutcome, HtmlOutcomeRenderer } from "../html-outcome";

export interface RsvpRefusalModel {
  title: string;
  message: string;
  /** Rooted return destination, e.g. `/e/<key>`: never an echoed body value. */
  returnPath: string;
}

/** Non-throttle refusal copy: the served page's generic message, verbatim. */
export const RSVP_REFUSAL_GENERIC_MESSAGE =
  "Nothing changed. Return to the event to check availability and try again.";

export interface RsvpRefusalInput {
  /** Refusal status from the JSON controller (403 closed, 429 limited, 503 outage). */
  status: number;
  /** Raw Retry-After header from the refusal, when the controller set one. */
  retryAfter: string | null;
  /** Raw :key param, exactly as routed. */
  eventKey: string;
  /** Normalized native attendee page (1 stays bare). */
  attendeePage?: number;
}

/**
 * Map one refused write onto the refusal model. A throttled write names the
 * announced wait (the served throttle copy with the controller's seconds, or
 * its moment fallback when the header is missing); every other refusal keeps
 * the generic message so error detail never leaks into the page.
 */
export function rsvpRefusalModelFor(input: RsvpRefusalInput): RsvpRefusalModel {
  // Same truthiness rule as the served adapter: an absent or empty header
  // selects the moment fallback instead of a number.
  const message =
    input.status === 429
      ? throttleWaitCopy(input.retryAfter ? Number(input.retryAfter) : null)
      : RSVP_REFUSAL_GENERIC_MESSAGE;
  const page = input.attendeePage ?? 1;
  return {
    title: RSVP_COPY.failedTitle,
    message,
    returnPath:
      Number.isSafeInteger(page) && page > 1
        ? `/e/${encodeURIComponent(input.eventKey)}?attendees=${page}`
        : `/e/${encodeURIComponent(input.eventKey)}`,
  };
}

export interface RsvpRefusalOutcomeOptions {
  status?: ContentfulStatusCode;
  headers?: Record<string, string>;
}

/**
 * Build one refusal outcome for the injected renderer. Status stays 200
 * unless the caller overrides it; headers carry only what the caller passes
 * (the controller's Retry-After). The private no-store cache posture and the
 * throttle's Vary already ride the context presets the JSON controller set
 * before refusing, so the outcome adds none of its own — forcing a default
 * here would reorder the served directives without changing their meaning.
 */
export function rsvpRefusalOutcome(
  model: RsvpRefusalModel,
  renderer: HtmlOutcomeRenderer<RsvpRefusalModel>,
  options?: RsvpRefusalOutcomeOptions,
): HtmlOutcome<RsvpRefusalModel> {
  return {
    model,
    renderer,
    status: options?.status ?? 200,
    headers: options?.headers ? { ...options.headers } : undefined,
  };
}
