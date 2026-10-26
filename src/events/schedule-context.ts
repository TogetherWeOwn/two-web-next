// Bounded navigation state only: never an arbitrary return URL or authority.
import {
  calendarUrl,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_UPCOMING_PAGE_SIZE,
  parseCalendarMonth,
  type CalendarState,
} from "../islands/contracts-calendar";
import { archiveEventHref, type ArchiveContext } from "./attendee-paths";

const MAX_CONTEXT_LENGTH = 4096;
const FIELDS = [
  "schedulePage",
  "scheduleQuery",
  "scheduleGame",
  "schedulePast",
  "scheduleView",
  "scheduleMonth",
] as const;
export type ScheduleContext = CalendarState;

/** Presentation state must not retarget the existing sign-in journey. */
export function withoutScheduleContext(search: string): string {
  const params = new URLSearchParams(search);
  if (!FIELDS.some((field) => params.has(field))) return search;
  for (const field of FIELDS) params.delete(field);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Refuse ambiguity and overlong raw values before normalization. */
export function scheduleContext(search: string): ScheduleContext | null {
  if (search.length > MAX_CONTEXT_LENGTH) return null;
  try {
    if (!decodeURIComponent(search)) return null;
  } catch {
    return null;
  }
  const params = new URLSearchParams(search);
  if (FIELDS.some((field) => params.getAll(field).length > 1)) return null;
  const rawPage = params.get("schedulePage") ?? "";
  const page = Number(rawPage);
  if (
    !/^[1-9]\d{0,15}$/.test(rawPage) ||
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger((page - 1) * EVENTS_UPCOMING_PAGE_SIZE)
  )
    return null;
  const q = params.get("scheduleQuery") ?? "";
  const game = params.get("scheduleGame") ?? "";
  if (
    [...q].length > EVENTS_SEARCH_MAX_LENGTH ||
    [...game].length > 255 ||
    /[\u0000-\u001f\u007f]/.test(game) ||
    q.includes("\u0000")
  )
    return null;
  const past = params.get("schedulePast");
  if (past !== null && past !== "1") return null;
  const view = params.get("scheduleView");
  const month = params.get("scheduleMonth");
  if (view !== null && view !== "calendar") return null;
  if (view === "calendar") {
    if (page !== 1 || q.trim() !== "" || !month || parseCalendarMonth(month) !== month) return null;
  } else if (month !== null) return null;
  return { view: view ?? "list", month: month ?? "", q, game, past: past === "1", page };
}

/** Callers supply the effective model state and admitted game, not raw URL keys. */
export function withScheduleContext(
  path: string,
  schedule: ScheduleContext | null | undefined,
): string {
  if (!schedule) return path;
  const [base, hash] = path.split("#");
  const [pathname, search] = base!.split("?");
  const params = new URLSearchParams(search);
  params.set("schedulePage", String(schedule.view === "calendar" ? 1 : schedule.page));
  if (schedule.q.trim()) params.set("scheduleQuery", schedule.q);
  if (schedule.game?.trim()) params.set("scheduleGame", schedule.game.trim());
  if (schedule.past) params.set("schedulePast", "1");
  if (schedule.view === "calendar") {
    params.set("scheduleView", "calendar");
    params.set("scheduleMonth", schedule.month);
  }
  const result = `${pathname}?${params}${hash ? `#${hash}` : ""}`;
  // Keep an unusable context out of entry links instead of emitting truncated state.
  return scheduleContext(`?${params}`) ? result : path;
}

export function scheduleReturnLink(eventKey: string, schedule: ScheduleContext | null | undefined) {
  return schedule
    ? {
        href: `${calendarUrl(schedule)}#event-${encodeURIComponent(eventKey)}`,
        label: schedule.view === "calendar" ? "← Back to calendar" : "← Back to schedule results",
      }
    : null;
}

/** Archive keeps precedence; browse context never enters OAuth or RSVP actions. */
export function browseEventHref(
  eventKey: string,
  archive: ArchiveContext | null | undefined,
  schedule: ScheduleContext | null | undefined,
  attendeePage = 1,
): string {
  const path = archiveEventHref(eventKey, archive, attendeePage);
  return archive ? path : withScheduleContext(path, schedule);
}
