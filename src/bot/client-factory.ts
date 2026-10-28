import { BotTerminalError, BotTransportError } from "../jobs/types";
import type { Announcement, BotFailure, EventUpsert, RoleAssignment } from "../jobs/types";
import type {
  AnnouncementResult,
  BotClientOptions,
  EventCancelResult,
  EventUpsertResult,
  RoleAssignResult,
} from "./client-types";
import { assertBotConfigured, send } from "./client-transport";
import { validateAnnouncement, validateEventUpsert, validateRoleAssign } from "./client-validation";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Live client. Also satisfies the queue consumer's BotClient for the result shapes it returns. */
export function createBotClient(opts: BotClientOptions) {
  const timeoutSeconds = opts.timeoutSeconds ?? 5;
  const fetchFn = opts.fetchFn ?? fetch;
  const cfg = () => {
    assertBotConfigured(opts);
    return {
      url: opts.url as string,
      secret: opts.secret as string,
      keyId: opts.keyId as string,
      timeoutSeconds,
      fetchFn,
      stderrDiagnostics: opts.stderrDiagnostics ?? false,
    };
  };

  return {
    assertConfigured(): void {
      assertBotConfigured(opts);
    },

    async assignRole(a: RoleAssignment): Promise<RoleAssignResult | BotFailure> {
      validateRoleAssign(a);
      const answer = await send(
        cfg(),
        { action: "role.assign", discord_id: a.userId, role_key: a.roleKey },
        null,
      );
      if (!answer.ok) return answer.failure;
      const outcome = str(answer.result["outcome"]);
      if (outcome !== "assigned" && outcome !== "already_held")
        throw new BotTransportError("a role.assign outcome this release does not know");
      return { ok: true, requestId: answer.requestId || null, outcome };
    },

    async postAnnouncement(
      a: Announcement,
      idempotencyKey: string,
    ): Promise<AnnouncementResult | BotFailure> {
      validateAnnouncement(a);
      const answer = await send(
        cfg(),
        { action: "announcement.post", channel_key: a.channelKey, body: a.body },
        idempotencyKey,
      );
      if (!answer.ok) return answer.failure;
      const messageId = str(answer.result["message_id"]);
      if (messageId === null || messageId.trim() === "")
        throw new BotTransportError("an announcement.post success with no message_id");
      return {
        ok: true,
        requestId: answer.requestId || null,
        messageId,
        replayed: answer.replayed,
      };
    },

    async upsertEvent(
      e: EventUpsert,
      idempotencyKey: string,
    ): Promise<EventUpsertResult | BotFailure> {
      validateEventUpsert(e);
      // validateEventUpsert throws unless endsAt is set; this narrows it for the compiler.
      const endsAt = e.endsAt;
      if (endsAt === null) throw new BotTerminalError("An event must end after it starts.");
      // `description` omitted rather than null: absent and null are not the
      // same thing to a validator that checks types, and the bot's is one.
      const payload: Record<string, string> = {
        action: "event.upsert",
        event_key: e.eventKey,
        name: e.name,
        starts_at: e.startsAt,
        ends_at: endsAt,
        location: e.location,
      };
      if (e.description !== null) payload["description"] = e.description;
      const answer = await send(cfg(), payload, idempotencyKey);
      if (!answer.ok) return answer.failure;
      const outcome = str(answer.result["outcome"]);
      if (outcome !== "created" && outcome !== "updated")
        throw new BotTransportError("an event.upsert outcome this release does not know");
      const discordEventId = str(answer.result["event_id"]);
      if (discordEventId === null || discordEventId.trim() === "")
        throw new BotTransportError("an event.upsert success with no event_id");
      return {
        ok: true,
        requestId: answer.requestId || null,
        outcome,
        discordEventId,
        replayed: answer.replayed,
      };
    },

    // Opt-in on the bot (TWO_INTERNAL_ALLOW_EVENT_CANCEL): a bot without it
    // answers a non-retryable `action_not_allowed`, which the queue treats as a
    // definitive refusal. Only an event the bot already mapped can be cancelled.
    async cancelEvent(
      e: { eventKey: string },
      idempotencyKey: string,
    ): Promise<EventCancelResult | BotFailure> {
      if (e.eventKey.trim() === "")
        throw new BotTerminalError("An event.cancel needs an event_key.");
      if ([...e.eventKey].length > 64)
        throw new BotTerminalError(
          `An event_key is at most 64 characters; this one is ${[...e.eventKey].length}.`,
        );
      const answer = await send(
        cfg(),
        { action: "event.cancel", event_key: e.eventKey },
        idempotencyKey,
      );
      if (!answer.ok) return answer.failure;
      if (str(answer.result["outcome"]) !== "cancelled")
        throw new BotTransportError("an event.cancel outcome this release does not know");
      const discordEventId = str(answer.result["event_id"]);
      if (discordEventId === null || discordEventId.trim() === "")
        throw new BotTransportError("an event.cancel success with no event_id");
      return {
        ok: true,
        requestId: answer.requestId || null,
        outcome: "cancelled",
        discordEventId,
      };
    },
  };
}

export type BotActionClient = ReturnType<typeof createBotClient>;
