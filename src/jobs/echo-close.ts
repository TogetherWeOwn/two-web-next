// Event Echo closing pass for the jobs worker (Living Lobby 7,
// bot-live-voice-contract §4). Rides the reconcile pass — no third cron
// trigger, no runScheduled change — so production triggers and the pinned
// jobs-worker-config split stay untouched.
//
// One pass: published events whose bot window closed (endsAt + 15 min + site
// grace) with no Echo yet are pulled from `event.attendance.read` and, on a
// `final:true` payload, written to `event_echoes` in one transaction, then
// posted to Discord via the existing `announcement.post` verb. `not_found`
// (flag off, pre-Echo) and `final:false` are honest pending states, retried
// by the next pass — never errors, never pages.
import type postgres from "postgres";
import { signedAttendanceReader } from "../bot/attendance-read";
import type { Db } from "../db/index";
import { drizzleOver } from "../db/proxy";
import type { JobsEnv } from "../env";
import {
  closeDueEchoes,
  listDueEchoEvents,
  markEchoAnnounced,
  writeEventEcho,
  type EchoCloseResult,
} from "../events/echoes";
import { dispatchAnnouncement } from "./call-internal-action";
import { trackingQueue } from "./ledger";
import { pgQueueLedger } from "./postgres";

export type EchoCloseEnv = Pick<
  JobsEnv,
  | "BOT_ENDPOINT_URL"
  | "BOT_KEY_ID"
  | "BOT_SHARED_SECRET"
  | "INTERNAL_ACTION_QUEUE"
  | "ECHO_ANNOUNCEMENT_CHANNEL_KEY"
>;

/** Run one Echo closing pass on the given pool. Never throws for bot-side
 * answers: unreachable/flag-off/open-window all report as pending for the
 * next pass. Throws only on site-side (database/queue) failures, which the
 * caller contains so the reconcile pass it rides stays green. */
export async function closeEventEchoes(deps: {
  env: EchoCloseEnv;
  sql: ReturnType<typeof postgres>;
}): Promise<EchoCloseResult> {
  // Store helpers share the web drizzle Db; the jobs pool crosses via the
  // same cast the sync store uses (src/jobs/events.ts).
  const db = drizzleOver(deps.sql) as unknown as Db;
  const channelKey = (deps.env.ECHO_ANNOUNCEMENT_CHANNEL_KEY ?? "").trim();
  return closeDueEchoes({
    listDue: () => listDueEchoEvents(db),
    read: signedAttendanceReader({
      baseUrl: deps.env.BOT_ENDPOINT_URL,
      keyId: deps.env.BOT_KEY_ID,
      secret: deps.env.BOT_SHARED_SECRET,
    }),
    write: (event, payload) => writeEventEcho(db, event, payload),
    // Unset channel key skips the Discord post without failing the Echo: the
    // row stands on the site and the post retries once configured.
    announce:
      channelKey === ""
        ? null
        : (event, body) =>
            dispatchAnnouncement(
              trackingQueue(deps.env.INTERNAL_ACTION_QUEUE, pgQueueLedger(deps.sql)),
              { channelKey, body },
            ),
    markPosted: (echoId) => markEchoAnnounced(db, echoId),
  });
}
