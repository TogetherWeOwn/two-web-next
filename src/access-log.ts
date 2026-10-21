// Member-access audit primitives (W7, ports RecordMemberDataAccess). The
// request-local declaration plus keyed read boundary in src/member-reads.ts
// is the only production audit path since PR #145: a read that cannot be
// recorded is never served, whatever MEMBER_ACCESS_LOG_ENFORCE says. The old
// declare-subjects Hono middleware was retired with its degrade branch —
// production never serves unaudited, so no serve-unaudited page exists.
// enforceOn survives only for the informational /up enforcement label; full
// flag retirement is a separate slice (it changes a dashboard-consumed
// public endpoint).

import type { Env } from "./env";

export type AccessDecl = {
  resource: string;
  action: "view" | "list";
  route: string;
  subjects: string[];
};

export type AccessEntry = {
  viewerDiscordId: string;
  viewerUserId: string | null;
  resource: string;
  action: string;
  subjectUserIds: string[];
  route: string | null;
};

/** Returns true when a row was written (the viewer is never their own subject). */
export type AccessSink = (entry: AccessEntry) => Promise<boolean>;

/**
 * Audit-wait deadline (CISO decision): a member read is released only after
 * its audit row is written, and that wait is bounded by this finite timeout.
 * Rationale: a hung audit must not hang the read forever (liveness) and must
 * never release private contents (fail closed with the existing sanitized
 * 503/private-no-store outage response). 5 s outlasts the DB-side
 * statement/lock cap (2 s in src/admin/store-access.ts) plus connect/BEGIN on
 * the shared max:1 pool, while bounding a never-settling sink well below the
 * 60 s outer test bound and worker limits. Driven by setTimeout +
 * Promise.race so fake timers govern it deterministically.
 *
 * A response deadline does not cancel database work: a late INSERT may still
 * commit server-side after the response was refused. The sink is still called
 * exactly once (no retry/replay); late settlement is inert.
 */
export const MEMBER_ACCESS_AUDIT_TIMEOUT_MS = 5000;

export function enforceOn(env: Env): boolean {
  const raw = env.MEMBER_ACCESS_LOG_ENFORCE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

/**
 * Bound an audit write by MEMBER_ACCESS_AUDIT_TIMEOUT_MS. Late settlement is
 * inert: the sink is awaited exactly once, a late rejection is consumed here
 * so it cannot surface as an unhandled rejection, and the caller decides the
 * timeout response (the race winner) without the late write altering it.
 */
export async function withAccessAuditDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Consume a late rejection after the deadline has won (house pattern: the
  // race below also observes it, this guarantees no unhandled rejection).
  pending.catch(() => {});
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("member access audit timed out")),
      MEMBER_ACCESS_AUDIT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
