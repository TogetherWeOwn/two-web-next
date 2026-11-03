// Event Echoes — site side of bot-live-voice-contract §4.
//
// Who writes what (contract §4):
//   BOT raw session log ──event.attendance.read──▶ SITE event_echoes
//        │                                              │ thread post
//        ▼                                              ▼ (existing bot verb)
//   (bot DB, 90 d)                            Discord thread + site cream band
//
// Rules the contract binds this module to:
// - The site is the ONLY writer of `event_echoes`, on a `final:true` payload,
//   in one transaction, with counts frozen at write. The host headline is the
//   one editable field — counts are never edited, only replaced by a
//   moderator-triggered re-pull before publication (announcement posted).
// - Pre-Echo events (windows closed before the writer existed) have no row
//   and are NEVER rewritten as attendance: they render from RSVP data
//   labelled "sign-up record".
// - Privacy floor F20: Echoes name counts and hosts publicly; individual
//   played-minutes reach only the member's own profile and moderators;
//   nobody's absence is ever published. Projections are enforced here,
//   server-side at serialization — public shapes never carry member rows.
// - Tournament placement ("3rd of 24", ties as ties) lives inside the Echo.
//   Placement is host-attested, not bot-measured, so it rides the headline
//   field (the one host-editable field), never the frozen counts.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AttendancePayload } from "../bot/attendance-read";
import { eventEchoMembers, eventEchoes, events } from "../db/admin-schema";
import type { Db } from "../db/index";
// Reads on member-facing and admin screens run inside the member-read
// boundary (src/member-reads.ts): frozen counts travel as the classified
// `event-echoes` non-sensitive read (statements pinned in
// src/db/read-classification.ts), per-member minutes as keyed reads whose
// Discord id the adapter attributes automatically. Outside a boundary both
// wrappers pass through untouched (jobs worker, tests).
import { keyedMemberRead, nonSensitiveRead } from "../member-reads";

export type EchoRow = typeof eventEchoes.$inferSelect;
export type EchoMemberRow = typeof eventEchoMembers.$inferSelect;

/** Statuses an Echo may be written for. Cancelled rows are retained response
 * history, not attendance; drafts are moderator-only previews. */
const ECHO_ELIGIBLE_STATUSES = new Set(["published", "past"]);

/** Grace after the bot window closes before the site treats an event as due:
 * the window already pads ends_at by 15 min bot-side; the extra hour keeps a
 * slow bot clock or a late session flush from minting a premature `not_found`
 * storm every 10-minute pass. */
export const ECHO_CLOSE_GRACE_MS = 60 * 60 * 1000;

/** Host headline bound (characters, matching the bot announcement counting
 * rule: characters, not bytes). */
export const ECHO_HEADLINE_MAX = 140;

const charLen = (s: string): number => [...s].length;

export class EchoWriteError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Refusing Echo write: ${reason}.`);
    this.name = "EchoWriteError";
    this.reason = reason;
  }
}

/** Pure build of the frozen record from a final payload. Throws EchoWriteError
 * on anything that must never write (non-final, key mismatch, ineligible
 * status). Counts derive from the payload's own threshold, which is stored
 * alongside so a future threshold change never rewrites old Echoes. */
export function buildEchoInsert(
  event: Pick<typeof events.$inferSelect, "id" | "eventKey" | "status">,
  payload: AttendancePayload,
): {
  echo: typeof eventEchoes.$inferInsert;
  members: (typeof eventEchoMembers.$inferInsert & { userId: string })[];
} {
  if (!ECHO_ELIGIBLE_STATUSES.has(event.status))
    throw new EchoWriteError(`event status ${event.status} never carries attendance`);
  if (!payload.final) throw new EchoWriteError("payload is not final");
  if (payload.event_key !== event.eventKey)
    throw new EchoWriteError("payload event_key does not match the event");
  const attended = payload.members.filter((m) => m.minutes >= payload.threshold_minutes);
  return {
    echo: {
      eventId: event.id,
      eventKey: event.eventKey,
      windowStartsAt: new Date(payload.window.starts_at),
      windowEndsAt: new Date(payload.window.ends_at),
      thresholdMinutes: payload.threshold_minutes,
      peakConcurrent: payload.peak_concurrent,
      attendedCount: attended.length,
      rooms: payload.rooms.map((r) => ({
        channel_id: r.channel_id,
        name_at_close: r.name_at_close,
      })),
    },
    members: payload.members.map((m) => ({
      // Placeholder echoId: the writer stamps the real id after insert.
      echoId: -1,
      userId: m.discord_id,
      minutes: m.minutes,
      sessions: m.sessions,
      firstJoinedAt: m.first_joined_at ? new Date(m.first_joined_at) : null,
    })),
  };
}

/** One Echo per event, in one transaction. A re-pull before publication
 * (announcement not yet posted) replaces the row and its member rows —
 * counts stay frozen from the latest accepted payload, never hand-edited.
 * After publication the row is immutable except the headline: a correction
 * then means a new superseding record with audit, not a silent edit (out of
 * scope for v1 — this writer refuses). */
export async function writeEventEcho(
  db: Db,
  event: Pick<typeof events.$inferSelect, "id" | "eventKey" | "status">,
  payload: AttendancePayload,
): Promise<{ written: true; echoId: number } | { written: false; reason: string }> {
  let built: ReturnType<typeof buildEchoInsert>;
  try {
    built = buildEchoInsert(event, payload);
  } catch (error) {
    if (error instanceof EchoWriteError) return { written: false, reason: error.reason };
    throw error;
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: eventEchoes.id, posted: eventEchoes.announcementPostedAt })
      .from(eventEchoes)
      .where(eq(eventEchoes.eventId, event.id));
    if (existing && existing.posted !== null)
      return { written: false, reason: "echo already published" };
    let echoId: number;
    if (existing) {
      // Re-pull replaces the frozen bot-owned facts only. The host headline
      // survives a re-pull: it is the one editable field and is never stamped
      // from bot data, so it is deliberately absent from this set.
      const { headline: _headline, eventId: _eventId, ...frozen } = built.echo;
      void _headline;
      void _eventId;
      await tx
        .update(eventEchoes)
        .set({ ...frozen, updatedAt: new Date() })
        .where(eq(eventEchoes.id, existing.id));
      await tx.delete(eventEchoMembers).where(eq(eventEchoMembers.echoId, existing.id));
      echoId = existing.id;
    } else {
      const [inserted] = await tx
        .insert(eventEchoes)
        .values(built.echo)
        .returning({ id: eventEchoes.id });
      if (!inserted) throw new EchoWriteError("echo insert returned no row");
      echoId = inserted.id;
    }
    if (built.members.length > 0) {
      await tx.insert(eventEchoMembers).values(
        built.members.map((m) => ({
          echoId,
          userId: m.userId,
          minutes: m.minutes,
          sessions: m.sessions,
          firstJoinedAt: m.firstJoinedAt,
        })),
      );
    }
    return { written: true as const, echoId };
  });
}

/** Headline-only edit. The update sets exactly one column: counts, window,
 * rooms and threshold can never change through this path (tested). Blank
 * clears back to the generated counts line. */
export function validateEchoHeadline(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new EchoWriteError("headline must be text");
  const headline = raw.trim();
  if (headline === "") return null;
  if (charLen(headline) > ECHO_HEADLINE_MAX)
    throw new EchoWriteError(`headline is at most ${ECHO_HEADLINE_MAX} characters`);
  return headline;
}

export async function updateEchoHeadline(
  db: Db,
  echoId: number,
  rawHeadline: unknown,
): Promise<EchoRow> {
  const headline = validateEchoHeadline(rawHeadline);
  const [updated] = await db
    .update(eventEchoes)
    .set({ headline, updatedAt: new Date() })
    .where(eq(eventEchoes.id, echoId))
    .returning();
  if (!updated) throw new EchoWriteError("echo not found");
  return updated;
}

/** Frozen-record copy lives in the island-contract leaf (no DB graph) so the
 * Kit card bundles it for browsers; re-exported here so server import paths
 * keep working. */
import {
  ECHO_RECORD_LABEL,
  SIGNUP_RECORD_LABEL,
  echoShortLine,
  recordLabel,
  type EchoCounts,
} from "../islands/contracts-echoes";
export { ECHO_RECORD_LABEL, SIGNUP_RECORD_LABEL, echoShortLine, recordLabel, type EchoCounts };

/** Shared copy for the site cream band AND the Discord thread post — one Echo
 * renders identically on both (acceptance). Stays within the 2000-character
 * announcement body bound by construction (counts copy is short; the
 * headline is capped at 140). */
export function echoAnnouncementBody(
  eventTitle: string,
  echo: Pick<EchoRow, "attendedCount" | "peakConcurrent" | "rooms" | "headline">,
): string {
  const roomNames = echo.rooms.map((r) => r.name_at_close).filter((n) => n !== "");
  const rooms =
    roomNames.length > 0
      ? ` across ${roomNames.length} room${roomNames.length === 1 ? "" : "s"}`
      : "";
  const counted = `${echo.attendedCount} showed up${rooms} · peak ${echo.peakConcurrent} in voice`;
  const lines = [`Last time, as the bot recorded it — ${eventTitle}`, counted];
  if (echo.headline) lines.push(echo.headline);
  if (roomNames.length > 0) lines.push(`Rooms: ${roomNames.slice(0, 5).join(" · ")}`);
  return lines.join("\n");
}

// --- F20 projections (server-side at serialization) ---

/** Public Echo: counts, rooms, peak, headline, window. Never member rows,
 * never absence — there is no per-member or "who missed it" field to leak. */
export type PublicEcho = {
  eventId: number;
  eventKey: string;
  label: typeof ECHO_RECORD_LABEL;
  headline: string | null;
  attendedCount: number;
  peakConcurrent: number;
  rooms: { name: string }[];
  windowEndsAt: string;
  thresholdMinutes: number;
};

/** The viewer's own played-minutes: own profile (and moderators, below). */
export type OwnEchoMinutes = {
  minutes: number;
  sessions: number;
  attended: boolean;
  thresholdMinutes: number;
};

export type ModeratorEchoMember = {
  userId: string;
  minutes: number;
  sessions: number;
  attended: boolean;
};

export function projectPublicEcho(
  echo: Pick<
    EchoRow,
    | "eventId"
    | "eventKey"
    | "headline"
    | "attendedCount"
    | "peakConcurrent"
    | "rooms"
    | "windowEndsAt"
    | "thresholdMinutes"
  >,
): PublicEcho {
  return {
    eventId: echo.eventId,
    eventKey: echo.eventKey,
    label: ECHO_RECORD_LABEL,
    headline: echo.headline,
    attendedCount: echo.attendedCount,
    peakConcurrent: echo.peakConcurrent,
    rooms: echo.rooms.map((r) => ({ name: r.name_at_close })),
    windowEndsAt: echo.windowEndsAt.toISOString(),
    thresholdMinutes: echo.thresholdMinutes,
  };
}

/** Own-profile minutes: the row for exactly one Discord id, or null when the
 * member has no Echo row (no absence is published — null reads as "no Echo
 * row for you", identical for below-threshold and never-there). */
export function projectOwnEchoMinutes(
  members: Pick<EchoMemberRow, "userId" | "minutes" | "sessions">[],
  userId: string,
  thresholdMinutes: number,
): OwnEchoMinutes | null {
  const row = members.find((m) => m.userId === userId);
  if (!row) return null;
  return {
    minutes: row.minutes,
    sessions: row.sessions,
    attended: row.minutes >= thresholdMinutes,
    thresholdMinutes,
  };
}

/** Moderator projection: every member row including below-threshold minutes.
 * Moderator-only admin views are the one place absence-adjacent data may
 * appear, and this shape never reaches a member-facing surface. */
export function projectModeratorEchoMembers(
  members: Pick<EchoMemberRow, "userId" | "minutes" | "sessions">[],
  thresholdMinutes: number,
): ModeratorEchoMember[] {
  return members
    .slice()
    .sort((a, b) => b.minutes - a.minutes || (a.userId < b.userId ? -1 : 1))
    .map((m) => ({
      userId: m.userId,
      minutes: m.minutes,
      sessions: m.sessions,
      attended: m.minutes >= thresholdMinutes,
    }));
}

// --- Closing pass (site cron) ---

export type EchoCloseEvent = Pick<
  typeof events.$inferSelect,
  "id" | "eventKey" | "title" | "status" | "endsAt"
>;

export type EchoCloseDeps = {
  now?: () => Date;
  /** Published events whose window closed (endsAt + 15 min + grace) with no Echo yet. */
  listDue: () => Promise<EchoCloseEvent[]>;
  read: (
    eventKey: string,
  ) => Promise<{ ok: true; attendance: AttendancePayload } | { ok: false; code: string }>;
  write: (
    event: EchoCloseEvent,
    payload: AttendancePayload,
  ) => Promise<{ written: boolean; reason?: string; echoId?: number }>;
  /** Enqueue the Discord thread post (the existing bot announcement verb —
   * no new verb). Null skips the post without failing the Echo: the row
   * stands on the site and the post retries once a channel key is configured. */
  announce: ((event: EchoCloseEvent, body: string) => Promise<void>) | null;
  markPosted?: (echoId: number) => Promise<void>;
};

export type EchoCloseResult = {
  checked: number;
  written: number;
  announced: number;
  pending: { eventKey: string; code: string }[];
};

/** Site closing pass: for each due event pull `event.attendance.read`; write
 * on `final:true` only, then post the thread via the existing bot
 * announcement verb. A failed post never unpicks the Echo — the row stands
 * on the site and the job retries the post. `not_found` (flag off,
 * pre-Echo) and `final:false` (window still open) are honest pending
 * states, not errors. */
export async function closeDueEchoes(deps: EchoCloseDeps): Promise<EchoCloseResult> {
  const due = await deps.listDue();
  const result: EchoCloseResult = { checked: due.length, written: 0, announced: 0, pending: [] };
  for (const event of due) {
    let answer: Awaited<ReturnType<EchoCloseDeps["read"]>>;
    try {
      answer = await deps.read(event.eventKey);
    } catch {
      result.pending.push({ eventKey: event.eventKey, code: "bot_unreachable" });
      continue;
    }
    if (!answer.ok) {
      result.pending.push({ eventKey: event.eventKey, code: answer.code });
      continue;
    }
    if (!answer.attendance.final) {
      result.pending.push({ eventKey: event.eventKey, code: "final_false" });
      continue;
    }
    let outcome: Awaited<ReturnType<EchoCloseDeps["write"]>>;
    try {
      outcome = await deps.write(event, answer.attendance);
    } catch {
      result.pending.push({ eventKey: event.eventKey, code: "write_failed" });
      continue;
    }
    if (!outcome.written || outcome.echoId === undefined) {
      result.pending.push({ eventKey: event.eventKey, code: outcome.reason ?? "write_refused" });
      continue;
    }
    result.written++;
    if (deps.announce === null) {
      result.pending.push({ eventKey: event.eventKey, code: "announce_unconfigured" });
      continue;
    }
    try {
      await deps.announce(
        event,
        echoAnnouncementBody(event.title, {
          attendedCount: answer.attendance.members.filter(
            (m) => m.minutes >= answer.attendance.threshold_minutes,
          ).length,
          peakConcurrent: answer.attendance.peak_concurrent,
          rooms: answer.attendance.rooms,
          headline: null,
        }),
      );
      result.announced++;
      await deps.markPosted?.(outcome.echoId);
    } catch {
      result.pending.push({ eventKey: event.eventKey, code: "announce_failed" });
    }
  }
  return result;
}

/** Due predicate shared by the store query and tests: published status with
 * the bot window (endsAt + 15 min) plus the site grace in the past. */
export function echoWindowDueAt(endsAt: Date): Date {
  return new Date(endsAt.getTime() + 15 * 60_000 + ECHO_CLOSE_GRACE_MS);
}

/** Production listDue against drizzle: published events past their due
 * instant with no Echo row yet, oldest first. */
export async function listDueEchoEvents(db: Db, now = new Date()): Promise<EchoCloseEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      eventKey: events.eventKey,
      title: events.title,
      status: events.status,
      endsAt: events.endsAt,
    })
    .from(events)
    .leftJoin(eventEchoes, eq(eventEchoes.eventId, events.id))
    .where(and(eq(events.status, "published"), isNull(eventEchoes.id)))
    .orderBy(asc(events.endsAt));
  return rows.filter((r) => echoWindowDueAt(r.endsAt) <= now);
}

/** Latest Echoes for the home cream band, newest first. */
export async function listRecentEchoes(
  db: Db,
  limit: number,
): Promise<(EchoRow & { eventTitle: string })[]> {
  const rows = await nonSensitiveRead("event-echoes", () =>
    db
      .select({ echo: eventEchoes, eventTitle: events.title })
      .from(eventEchoes)
      .innerJoin(events, eq(events.id, eventEchoes.eventId))
      .orderBy(desc(eventEchoes.windowEndsAt))
      .limit(limit),
  );
  return rows.map((r) => ({ ...r.echo, eventTitle: r.eventTitle }));
}

/** One event's Echo with its display title, or null for pre-Echo events
 * (which render the sign-up record, never rewritten). */
export async function getEventEcho(
  db: Db,
  eventId: number,
): Promise<(EchoRow & { eventTitle: string }) | null> {
  const [row] = await nonSensitiveRead("event-echoes", () =>
    db
      .select({ echo: eventEchoes, eventTitle: events.title })
      .from(eventEchoes)
      .innerJoin(events, eq(events.id, eventEchoes.eventId))
      .where(eq(eventEchoes.eventId, eventId)),
  );
  return row ? { ...row.echo, eventTitle: row.eventTitle } : null;
}

/** Batch Echo lookup for archive/home lists: event ids in, Echo rows out. */
export async function mapEchoesByEvent(db: Db, eventIds: number[]): Promise<Map<number, EchoRow>> {
  const out = new Map<number, EchoRow>();
  if (eventIds.length === 0) return out;
  const rows = await nonSensitiveRead("event-echoes", () =>
    db.select().from(eventEchoes).where(inArray(eventEchoes.eventId, eventIds)),
  );
  for (const row of rows) out.set(row.eventId, row);
  return out;
}

/** Batch member-row lookup for one Echo (own-profile + moderator views).
 * Keyed: the adapter attributes each row's Discord id as the read subject,
 * so moderator views land in the access log and self reads stay silent. */
export async function listEchoMembers(db: Db, echoId: number): Promise<EchoMemberRow[]> {
  return keyedMemberRead(() =>
    db.select().from(eventEchoMembers).where(eq(eventEchoMembers.echoId, echoId)),
  );
}

/** How many Echoes the admin list shows, newest first. */
export const ECHO_ADMIN_LIMIT = 50;

/** Admin list rows: the frozen record plus its event title. Counts only —
 * member rows load on the detail view, never the list. */
export async function listAdminEchoes(
  db: Db,
  limit: number = ECHO_ADMIN_LIMIT,
): Promise<(EchoRow & { eventTitle: string })[]> {
  return listRecentEchoes(db, limit);
}

/** One Echo with its title for the admin detail view, or null. */
export async function getAdminEcho(
  db: Db,
  id: number,
): Promise<(EchoRow & { eventTitle: string }) | null> {
  const [row] = await nonSensitiveRead("event-echoes", () =>
    db
      .select({ echo: eventEchoes, eventTitle: events.title })
      .from(eventEchoes)
      .innerJoin(events, eq(events.id, eventEchoes.eventId))
      .where(eq(eventEchoes.id, id)),
  );
  return row ? { ...row.echo, eventTitle: row.eventTitle } : null;
}

/** How many of the viewer's own Echo rows the profile shows, newest first. */
export const ECHO_PROFILE_LIMIT = 5;

export type OwnEchoRow = {
  eventKey: string;
  eventTitle: string;
  windowEndsAt: Date;
  headline: string | null;
  minutes: OwnEchoMinutes;
};

/** The viewer's own played-minutes across recent Echoes, newest first — the
 * F20 own-profile view. One row per Echo the viewer has a member row in;
 * Echoes without a row for this viewer never appear (no absence published).
 * Callers gate on the profile owner (or a moderator surface), never guests. */
export async function listOwnEchoRows(
  db: Db,
  userId: string,
  limit: number = ECHO_PROFILE_LIMIT,
): Promise<OwnEchoRow[]> {
  // Keyed: the projected user_id attributes the row to its owner (the
  // adapter needs the key column present; it is dropped below, never
  // rendered — the F20 projection carries minutes only).
  const rows = await keyedMemberRead(() =>
    db
      .select({
        userId: eventEchoMembers.userId,
        eventKey: events.eventKey,
        eventTitle: events.title,
        windowEndsAt: eventEchoes.windowEndsAt,
        headline: eventEchoes.headline,
        thresholdMinutes: eventEchoes.thresholdMinutes,
        minutes: eventEchoMembers.minutes,
        sessions: eventEchoMembers.sessions,
      })
      .from(eventEchoMembers)
      .innerJoin(eventEchoes, eq(eventEchoes.id, eventEchoMembers.echoId))
      .innerJoin(events, eq(events.id, eventEchoes.eventId))
      .where(eq(eventEchoMembers.userId, userId))
      .orderBy(desc(eventEchoes.windowEndsAt))
      .limit(limit),
  );
  return rows.map((r) => ({
    eventKey: r.eventKey,
    eventTitle: r.eventTitle,
    windowEndsAt: r.windowEndsAt,
    headline: r.headline,
    minutes: {
      minutes: r.minutes,
      sessions: r.sessions,
      attended: r.minutes >= r.thresholdMinutes,
      thresholdMinutes: r.thresholdMinutes,
    },
  }));
}

/** Stamp the Discord post outcome. */
export async function markEchoAnnounced(db: Db, echoId: number, at = new Date()): Promise<void> {
  await db
    .update(eventEchoes)
    .set({ announcementPostedAt: at, updatedAt: at })
    .where(eq(eventEchoes.id, echoId));
}

/** Past-window cutoff for the Echo retention story: raw bot sessions die at
 * 90 days bot-side; site aggregates live on as the record. No site prune. */
export const ECHO_AGGREGATE_RETENTION = "permanent" as const;

/** Moderator re-pull guard, tested: refresh only before publication. */
export function canRefreshEcho(echo: Pick<EchoRow, "announcementPostedAt">): boolean {
  return echo.announcementPostedAt === null;
}

/** Events whose window closed before the writer existed have no Echo and
 * never get one — the archive query proves it by construction (no backfill
 * writes, only reads). This helper names the policy at the call site. */
export function isPreEchoEvent(windowEndsAt: Date, writerEnabledAt: Date): boolean {
  return windowEndsAt < writerEnabledAt;
}
