// Model for the structured-time `row` presentation (Kit C1 time column, design
// packet D-4/D-5). Formatting is date-format.ts in the stored zone; there is no
// relative text, viewer zone or clock, so the same input renders the same bytes.
import { effectiveZone, instantIso, wallTimeHm } from "../../../src/events/date-format";

export type RowTimeState = "upcoming" | "past" | "cancelled";
/** A Date, or an ISO string with an explicit Z or offset (never parsed in a local zone). */
export type Instant = Date | string | null | undefined;

export interface RowTimeInput {
  state: RowTimeState;
  startsAt: Instant;
  endsAt?: Instant;
  /** The event's stored zone; unreadable or absent reads and is named UTC. */
  zone?: string | null;
}

export interface RowTimeModel {
  available: boolean;
  /** UTC ISO instant for `<time datetime>`; empty when unavailable. */
  iso: string;
  line1: string;
  line2: string;
  struck: boolean;
  cancelled: boolean;
}

const EXPLICIT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

export function toInstant(value: Instant): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string") return null;
  const match = EXPLICIT.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

const fmt = (d: Date, zone: string, o: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...o }).format(d);

export function rowTimeModel({ state, startsAt, endsAt, zone }: RowTimeInput): RowTimeModel {
  const start = toInstant(startsAt);
  if (!start) {
    return {
      available: false,
      iso: "",
      line1: "Time to be confirmed",
      line2: "",
      struck: false,
      cancelled: false,
    };
  }
  const z = effectiveZone(zone);
  const date = `${fmt(start, z, { weekday: "short" })} ${fmt(start, z, { day: "numeric", month: "short" })}`;
  const upcoming = state === "upcoming";
  return {
    available: true,
    iso: instantIso(start),
    line1: upcoming ? `${fmt(start, z, { weekday: "short" })} ${wallTimeHm(start, z)}` : date,
    line2: state === "past" && toInstant(endsAt) ? "ended" : z,
    struck: state === "cancelled",
    cancelled: state === "cancelled",
  };
}
