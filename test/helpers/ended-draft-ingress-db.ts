import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { MemberDataFixture } from "./member-data-db";
import { makeFakeAgentDb, type FakeGrant } from "./fake-agent-ingress-db";

export type EndedDraftFixture = Pick<MemberDataFixture, "client" | "reset" | "dispose"> &
  Partial<Pick<MemberDataFixture, "db">>;

type EventRow = {
  id: string;
  event_key: string;
  agent_grant_id: string | null;
  proof_marker: string | null;
  title: string;
  game: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location: string;
  capacity: number | null;
  status: string;
  agent_version: number;
  discord_event_id: null;
  updated_at: Date;
};

// Extend the shared ingress double only at its event/storage boundary. The
// real admission, dispatch, audits, receipts and write-back still execute.
// The row rendezvous is deterministic behavioral coverage, not PostgreSQL
// lock evidence; the same acceptance suite uses real SQL when configured.
export function createEndedDraftIngressDb(): EndedDraftFixture {
  let fake = makeFakeAgentDb();
  let grant: (FakeGrant & { verifier_hash: string }) | undefined;
  const events = new Map<string, EventRow>();
  const receipts = new Set<string>();
  const audits: { operation: string; event_key: unknown; result: unknown; reason_code: unknown }[] =
    [];
  const locks = new Map<string, { owner: number; released: Promise<void>; release: () => void }>();
  const waiters = new Map<number, number>();
  let nextPid = 0;

  const acquire = async (id: string, pid: number) => {
    if (pid === 0) throw new Error("Event row lock requested outside a transaction");
    let held = locks.get(id);
    while (held && held.owner !== pid) {
      waiters.set(pid, held.owner);
      try {
        await held.released;
      } finally {
        waiters.delete(pid);
      }
      held = locks.get(id);
    }
    if (!held) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(id, { owner: pid, released, release });
    }
  };

  const wrap = (pid: number): postgres.Sql =>
    new Proxy(fake.sql, {
      apply: async (_target, _thisArg, args: [TemplateStringsArray, ...unknown[]]) => {
        const [strings, ...values] = args;
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        if (
          /^DELETE FROM (agent_event_idempotency_keys|agent_event_hits|agent_event_grants)$/.test(
            text,
          )
        )
          return [];
        if (text.startsWith("INSERT INTO agent_event_grants")) {
          grant = {
            id: randomUUID(),
            agent_id: values[0] as string,
            guild_id: values[1] as string,
            verifier_hash: values[2] as string,
            expires_at: null,
            disabled_at: null,
          };
          return [];
        }
        if (text.includes("FROM agent_event_grants WHERE verifier_hash"))
          return grant?.verifier_hash === values[0] ? [{ ...grant }] : [];
        if (text.includes("FROM agent_event_grants WHERE id")) {
          if (!grant || grant.id !== values[0]) return [];
          return text.includes("expires_at_ms")
            ? [{ expires_at_ms: null, disabled: false }]
            : [{ id: grant.id }];
        }
        if (text.startsWith("INSERT INTO events")) {
          const owned = text.includes("agent_grant_id");
          const [
            eventKey,
            grantId,
            marker,
            title,
            game,
            description,
            starts,
            ends,
            zone,
            location,
            capacity,
          ] = owned
            ? values
            : [
                values[0],
                null,
                null,
                values[1],
                null,
                null,
                values[2],
                values[3],
                "UTC",
                values[4],
                null,
              ];
          events.set(eventKey as string, {
            id: randomUUID(),
            event_key: eventKey as string,
            agent_grant_id: grantId as string | null,
            proof_marker: marker as string | null,
            title: title as string,
            game: game as string | null,
            description: description as string | null,
            starts_at: starts as string,
            ends_at: ends as string,
            timezone: zone as string,
            location: location as string,
            capacity: capacity as number | null,
            status: "draft",
            agent_version: 1,
            discord_event_id: null,
            updated_at: new Date(),
          });
          return [];
        }
        if (text.startsWith("SELECT") && text.includes("FROM events WHERE")) {
          const row = text.includes("WHERE id =")
            ? [...events.values()].find((event) => event.id === values[0])
            : text.includes("WHERE agent_grant_id =")
              ? [...events.values()].find((event) => event.agent_grant_id === values[0])
              : events.get(values[0] as string);
          if (!row) return [];
          if (text.endsWith("FOR UPDATE")) await acquire(row.id, pid);
          const columns = text.slice("SELECT ".length, text.indexOf(" FROM events"));
          if (columns !== "*" && columns.split(", ").some((column) => !(column in row)))
            throw new Error(`Unmodelled event projection: ${columns}`);
          return columns === "*"
            ? [{ ...row }]
            : [
                Object.fromEntries(
                  columns.split(", ").map((column) => [column, row[column as keyof EventRow]]),
                ),
              ];
        }
        if (text.startsWith("UPDATE events SET location =")) {
          const row = events.get(values[1] as string);
          if (row) row.location = values[0] as string;
          return [];
        }
        if (text.startsWith("UPDATE events SET status =")) {
          const row = events.get(values[1] as string);
          if (row) {
            row.status = values[0] as string;
            row.updated_at = new Date();
          }
          return [];
        }
        if (text === "SELECT pg_backend_pid() AS pid") return [{ pid }];
        if (text.startsWith("SELECT pid FROM pg_stat_activity"))
          return [...waiters]
            .filter(([, holder]) => holder === values[0])
            .map(([pid]) => ({ pid }));
        if (text.startsWith("SELECT result, reason_code FROM agent_event_audits"))
          return audits
            .filter((audit) => audit.operation === "publish" && audit.event_key === values[0])
            .map(({ result, reason_code }) => ({ result, reason_code }));
        if (text.startsWith("INSERT INTO agent_event_audits"))
          audits.push({
            operation: values[1] as string,
            event_key: values[2],
            result: values[6],
            reason_code: values[7],
          });
        if (text.startsWith("SELECT count(*)::int AS n FROM agent_event_idempotency_keys"))
          return [{ n: receipts.has(values[0] as string) ? 1 : 0 }];
        if (text.startsWith("INSERT INTO agent_event_idempotency_keys"))
          receipts.add(values[1] as string);
        return Reflect.apply(fake.sql, undefined, args);
      },
      get: (_target, prop) => {
        if (prop === "unsafe")
          return async (statement: string) => {
            if (
              /^SET LOCAL (lock_timeout|statement_timeout) = '\d+ms'$/.test(statement) ||
              /^ALTER TABLE "agent_event_audits" (DISABLE|ENABLE) TRIGGER "agent_event_audits_no_truncate"$/.test(
                statement,
              ) ||
              statement === 'TRUNCATE "agent_event_audits"'
            )
              return [];
            throw new Error(`Unmodelled unsafe statement: ${statement}`);
          };
        if (prop !== "begin") return Reflect.get(fake.sql, prop);
        return async (callback: (tx: postgres.Sql) => Promise<unknown>) => {
          const transactionPid = ++nextPid;
          try {
            return await callback(wrap(transactionPid));
          } finally {
            for (const [id, lock] of locks) {
              if (lock.owner !== transactionPid) continue;
              locks.delete(id);
              lock.release();
            }
          }
        };
      },
    });

  return {
    client: wrap(0),
    reset: async () => {
      fake = makeFakeAgentDb();
      grant = undefined;
      events.clear();
      receipts.clear();
      audits.length = 0;
      if (locks.size || waiters.size) throw new Error("Unsettled event-row rendezvous at reset");
    },
    dispose: async () => {
      if (locks.size || waiters.size) throw new Error("Unsettled event-row rendezvous at disposal");
    },
  };
}
