// Ports. The Rust bot's HTTP client and the events store land in later slices; the queue and cron
// logic below is written against these so it tests without either.

export type EventUpsert = {
  eventKey: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  description: string | null;
};

export type Announcement = { channelKey: string; body: string };
export type RoleAssignment = { userId: string; roleKey: string };

export type BotFailure = {
  ok: false;
  code: string;
  status: number;
  requestId: string | null;
  message: string;
  /** The bot's `retryable` flag is authoritative, never the HTTP status. */
  retryable: boolean;
  retryAfterSeconds: number | null;
};
export type BotSuccess<T> = { ok: true; requestId: string | null } & T;

/** Could not ask (bot down): a wait, never a failure. */
export class BotTransportError extends Error {}
/** Missing secret / payload the bot would call malformed: terminal. */
export class BotTerminalError extends Error {}

export interface BotClient {
  upsertEvent(p: EventUpsert, idempotencyKey: string): Promise<BotSuccess<{ discordEventId: string }> | BotFailure>;
  postAnnouncement(a: Announcement, idempotencyKey: string): Promise<BotSuccess<{ messageId: string; replayed: boolean }> | BotFailure>;
  assignRole(r: RoleAssignment): Promise<BotSuccess<{ outcome: string }> | BotFailure>;
}

export type MirroredEvent = { eventKey: string; payload: EventUpsert; mirrored: boolean };

export interface EventStore {
  find(eventKey: string): Promise<MirroredEvent | null>;
  /** Persist discord_event_id and stamp only RSVPs updated at or before `mirroredAt`. */
  recordMirrored(eventKey: string, discordEventId: string, mirroredAt: Date): Promise<void>;
  /** Published events past ends_at -> past. Returns rows changed. */
  closeFinished(now: Date): Promise<number>;
  /** Top up every live series (draft/published parent). Returns rows created; idempotent. */
  materializeSeries(): Promise<number>;
  /** Published, and discord_event_id null or any RSVP unsynced. */
  staleEventKeys(): Promise<string[]>;
}

export interface AccessLogStore {
  pruneOlderThan(cutoff: Date): Promise<number>;
}

/** ShouldBeUnique: acquire returns false while another holder's lock is live. */
export interface UniqueLock {
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export type QueueMessage =
  | { kind: "sync-event"; eventKey: string; idempotencyKey: string }
  | { kind: "announcement"; idempotencyKey: string; action: Announcement }
  | { kind: "role-assign"; idempotencyKey: null; action: RoleAssignment };
