// Server-only native controls for the non-hydrated Kit events inventory.
import { escapeToBuffer } from "hono/utils/html";
import type { EventStartsWindow } from "./event-list";

/** Use Hono's HTML escaper rather than interpolating even normalized values. */
function attribute(value: string): string {
  const buffer: [string] = [""];
  escapeToBuffer(value, buffer);
  return buffer[0];
}

/** Same native GET controls as EventsPage, delivered through trusted load data
 * like the pause reviews so their inert markup stays out of the client JS. */
export function renderEventStartsInputsHtml(window: EventStartsWindow | undefined): string {
  return (
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
