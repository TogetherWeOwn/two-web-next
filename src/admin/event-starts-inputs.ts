// Shared server-only date controls and feedback for both native inventories.
import { escapeToBuffer } from "hono/utils/html";
import { eventStartsWindowSummary, type EventStartsWindow } from "./event-list";

/** Use Hono's HTML escaper rather than interpolating even normalized values. */
function attribute(value: string): string {
  const buffer: [string] = [""];
  escapeToBuffer(value, buffer);
  return buffer[0];
}

/** Escaped feedback shares one renderer instead of two inert client branches. */
export function renderEventStartsFeedbackHtml(window: EventStartsWindow | undefined): string {
  if (window?.error) {
    return `<p class="notice event-window-notice" role="alert">${attribute(window.error)}</p>`;
  }
  const summary = eventStartsWindowSummary(window);
  return summary ? `<p>${attribute(summary)}</p>` : "";
}

/** Same native GET date controls as EventsPage; the hidden correction marker
 * keeps blank rejected endpoints refused until correction or explicit clear. */
export function renderEventStartsInputsHtml(window: EventStartsWindow | undefined): string {
  return (
    (window?.required
      ? `<input type="hidden" name="starts_required" value="${attribute(String(window.required))}" />`
      : "") +
    '<div class="field"><label for="starts_from">Starts from (UTC date, included)</label>' +
    '<input id="starts_from" name="starts_from" type="date" value="' +
    attribute(window?.from ?? "") +
    '" /></div>' +
    '<div class="field"><label for="starts_before">Starts before (UTC date, excluded)</label>' +
    '<input id="starts_before" name="starts_before" type="date" value="' +
    attribute(window?.before ?? "") +
    '" /></div>'
  );
}
