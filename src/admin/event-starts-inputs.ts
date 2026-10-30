// Shared server-only controls and feedback for both native events inventories.
import { escapeToBuffer } from "hono/utils/html";
import {
  eventStartsWindowSummary,
  eventListHasFilters,
  eventListClearUrl,
  type EventStartsWindow,
  type EventListQuery,
} from "./event-list";

/** Use Hono's HTML escaper rather than interpolating even normalized values. */
function attribute(value: string): string {
  const buffer: [string] = [""];
  escapeToBuffer(value, buffer);
  return buffer[0];
}

/** Native select fields are identical in both server-rendered inventories. */
function selectField(
  name: string,
  label: string,
  selected: string,
  options: readonly (readonly [string, string])[],
): string {
  return (
    `<div class="field"><label for="${name}">${label}</label><select id="${name}" name="${name}">` +
    options
      .map(
        ([value, text]) =>
          `<option value="${value}"${value === selected ? " selected" : ""}>${text}</option>`,
      )
      .join("") +
    "</select></div>"
  );
}

/** No client events: all query values are escaped into ordinary GET controls. */
export function renderEventFilterFieldsHtml(query: EventListQuery): string {
  return (
    `<input type="hidden" name="sort" value="${attribute(query.sort)}" />` +
    `<input type="hidden" name="order" value="${attribute(query.order)}" />` +
    '<div class="field"><label for="q">Search titles and games</label>' +
    `<input id="q" name="q" type="search" value="${attribute(query.q)}" aria-describedby="q-help" />` +
    '<p class="hint" id="q-help">Matches event titles and saved games.</p></div>' +
    selectField("status", "Status", query.status, [
      ["", "All"],
      ["draft", "draft"],
      ["published", "published"],
      ["cancelled", "cancelled"],
      ["past", "past"],
    ]) +
    selectField("rsvp_open", "RSVPs", query.rsvp_open, [
      ["", "All"],
      ["1", "Open"],
      ["0", "Paused"],
    ]) +
    selectField("series", "Series", query.series, [
      ["", "All"],
      ["parent", "Parent"],
      ["child", "Child"],
      ["standalone", "Standalone"],
    ]) +
    selectField("fill", "Fill", query.fill, [
      ["", "All"],
      ["full", "Full"],
      ["has_seats", "Has seats"],
      ["unlimited", "Unlimited"],
    ])
  );
}

export function renderEventFilterActionsHtml(query: EventListQuery): string {
  return (
    '<div class="field"><button type="submit" class="btn">Filter</button></div>' +
    (eventListHasFilters(query)
      ? `<div class="field"><a href="${attribute(eventListClearUrl(query))}">Clear filters</a></div>`
      : "")
  );
}

/** Escaped feedback shares one renderer instead of two inert client branches. */
export function renderEventStartsFeedbackHtml(window: EventStartsWindow | undefined): string {
  if (window?.error) {
    return `<p class="notice event-window-notice" role="alert">${attribute(window.error)}</p>`;
  }
  const summary = eventStartsWindowSummary(window);
  return summary ? `<p>${attribute(summary)}</p>` : "";
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
