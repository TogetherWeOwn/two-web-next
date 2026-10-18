// In-memory Sql double for the agent-events ingress nightly mutants.
//
// Covers exactly the statements `admitAgentEvent` / `processAgentEvent` issue
// on the denial paths and the draft-create happy path: the outer shield and
// inner rate limiter (`agent_event_hits`), grant lookup, replay lookup,
// audit inserts, the in-transaction `checkGrant` re-read, the create quota
// check and the create/event-key inserts. Anything else throws loudly so a
// test that strays onto an unmodelled path (read/update/publish/cancel) fails
// instead of silently passing.
//
// DB-free by construction: no DATABASE_URL, no Discord, no network. Time is
// real (Date.now) and digests use the real `sha256Hex`, so the double agrees
// with production on identity while storing nothing outside the test.
import type postgres from "postgres";
import { sha256Hex } from "../../src/bot/signer";

export type FakeGrant = {
  id: string;
  agent_id: string;
  guild_id: string;
  expires_at: Date | null;
  disabled_at: Date | null;
};

export type FakeReplayRow = {
  payload_digest: string;
  status: number;
  body: string;
  event_key: string;
};

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export type FakeAgentDb = {
  sql: postgres.Sql;
  audits: {
    grantId: string | null;
    operation: string;
    reason: string | null;
    requestId: string | null;
    result: string | null;
  }[];
  hits: { bucket: string; at: number }[];
  addGrant: (credential: string, grant: FakeGrant) => Promise<void>;
  seedReplay: (grantId: string, key: string, row: FakeReplayRow) => void;
  /** Spend a rate bucket past every configured budget (shield buckets untouched). */
  prespend: (bucket: string, n?: number) => void;
  /** First replay lookup misses, later ones hit: models a concurrent store. */
  armRace: (grantId: string, key: string, row: FakeReplayRow) => void;
};

export function makeFakeAgentDb(): FakeAgentDb {
  const hashes = new Map<string, FakeGrant>();
  const replays = new Map<string, FakeReplayRow>();
  const audits: FakeAgentDb["audits"] = [];
  const hits: FakeAgentDb["hits"] = [];
  const ownedEvents = new Map<string, { event_key: string }>();
  let race: { grantId: string; key: string; row: FakeReplayRow } | null = null;
  let lookups = 0;

  const countFor = (bucket: string) => {
    const cutoff = Date.now() - 60_000;
    const rows = hits.filter((h) => h.bucket === bucket && h.at > cutoff);
    const wait =
      rows.length === 0
        ? 1
        : Math.max(1, Math.ceil((Math.min(...rows.map((h) => h.at)) + 60_000 - Date.now()) / 1000));
    return [{ n: rows.length, wait }];
  };

  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // postgres.js splits the statement around each interpolation: the lock
    // suffix (`FOR SHARE`) lives after the last value, so match against the
    // whole template, not just the head.
    const head = strings[0] ?? "";
    const text = strings.join(" ");

    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SET LOCAL lock_timeout")) return [];
    if (head.includes("WITH candidates")) return [];
    if (head.includes("DELETE FROM agent_event_hits")) return [];

    if (head.includes("agent_event_hits") && head.includes("count(*)")) {
      return countFor(values[0] as string);
    }
    if (head.includes("INSERT INTO agent_event_hits")) {
      hits.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }

    if (head.includes("FROM agent_event_grants WHERE verifier_hash")) {
      const grant = hashes.get(values[0] as string) ?? null;
      return grant ? [grant] : [];
    }
    if (text.includes("FOR SHARE")) {
      const id = values[0] as string;
      const grant = [...hashes.values()].find((g) => g.id === id);
      return grant ? [{ id }] : [];
    }
    if (head.includes("expires_at_ms")) {
      const id = values[0] as string;
      const grant = [...hashes.values()].find((g) => g.id === id);
      if (!grant) return [];
      return [
        {
          expires_at_ms: grant.expires_at ? grant.expires_at.getTime() : null,
          disabled: grant.disabled_at !== null,
        },
      ];
    }

    if (head.includes("FROM agent_event_idempotency_keys WHERE grant_id")) {
      const [grantId, key] = values as [string, string];
      lookups += 1;
      if (race && grantId === race.grantId && key === race.key) {
        if (lookups === 1) return [];
        return [race.row];
      }
      return replays.has(`${grantId}:${key}`) ? [replays.get(`${grantId}:${key}`)] : [];
    }
    if (head.includes("INSERT INTO agent_event_idempotency_keys")) {
      const [grantId, key, dig, status, body, eventKey] = values as [
        string,
        string,
        string,
        number,
        string,
        string | null,
      ];
      replays.set(`${grantId}:${key}`, {
        payload_digest: dig,
        status,
        body,
        event_key: eventKey ?? "",
      });
      return [];
    }

    if (head.includes("INSERT INTO agent_event_audits")) {
      const [grantId, operation, , , , requestId, result, reason] = values as [
        string | null,
        string,
        unknown,
        unknown,
        unknown,
        string | null,
        string | null,
        string | null,
      ];
      audits.push({ grantId, operation, reason, requestId, result });
      return [];
    }

    if (head.includes("SELECT event_key FROM events WHERE agent_grant_id")) {
      const owned = ownedEvents.get(values[0] as string);
      return owned ? [{ event_key: owned.event_key }] : [];
    }
    if (head.includes("FROM events WHERE agent_grant_id")) {
      return [];
    }
    if (head.includes("FROM events WHERE event_key")) {
      return [];
    }
    if (head.includes("INSERT INTO events")) {
      const [eventKey, grantId] = values as [string, string];
      ownedEvents.set(grantId, { event_key: eventKey });
      return [];
    }

    if (head.includes("FROM agent_event_audits WHERE grant_id")) {
      return [];
    }

    throw new Error(`fakeAgentDb: unexpected statement: ${head.slice(0, 100)}`);
  }) as unknown as postgres.Sql;

  // Attach the transaction seams through `unknown` fields (same pattern as
  // `test/helpers/throttle-tx-double.ts`) so the postgres.js `Sql` type never
  // constrains the double.
  (run as unknown as { unsafe?: unknown }).unsafe = async () => [];
  (run as unknown as { end?: unknown }).end = async () => {};
  (run as unknown as { begin?: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(run);

  const sql = run as unknown as postgres.Sql;

  return {
    sql,
    audits,
    hits,
    addGrant: async (credential: string, grant: FakeGrant) => {
      hashes.set(await sha256Hex(credential), grant);
    },
    seedReplay: (grantId: string, key: string, row: FakeReplayRow) => {
      replays.set(`${grantId}:${key}`, row);
    },
    prespend: (bucket: string, n = 999) => {
      for (let i = 0; i < n; i++) hits.push({ bucket, at: Date.now() });
    },
    armRace: (grantId: string, key: string, row: FakeReplayRow) => {
      race = { grantId, key, row };
    },
  };
}

export type { Tag };
