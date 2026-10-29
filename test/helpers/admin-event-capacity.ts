// Independent fixture for the event-capacity snapshot acceptance. No network
// or database connection. Real Drizzle SQL, read classification, keyed
// attribution, guards, the Hono GET/POST handlers, the Kit load and executed
// Svelte SSR stay in the path. Only the mapped DB adapter and
// framework/environment bindings are replaced. This is not a PostgreSQL proof.
//
// Ownership: this file and test/admin-event-capacity-acceptance.test.ts.
//
// The Kit bundle deliberately tolerates the builder's new read: the db, reads
// and store-event-reads bridges re-export the real modules (so a new aggregate
// export keeps bundling) while the request-scoped reads AND the member-reads
// primitives resolve to the outer instances (so classification and the audit
// attribution run in the request's own AsyncLocalStorage boundary, exactly
// like the Hono twin). A new module file of the builder's own bundles
// normally; only a new member-reads primitive would need a bridge entry.
import { build } from "esbuild";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbFor } from "../../src/admin/db";
import { listRoster } from "../../src/admin/reads";
import { getEvent } from "../../src/admin/store-event-reads";
import type { EventRow } from "../../src/admin/store";
import type { Db } from "../../src/db/index";
import type { KitLocals } from "../../src/kit-session";
import {
  captureMemberKeys,
  declareMemberResult,
  keyedMemberRead,
  memberQueryPermit,
  memberReadActive,
  nonSensitiveRead,
  refuseMemberRead,
} from "../../src/member-reads";
import { idFor, key, needle, path, statuses } from "./admin-roster-status";

export { key, needle, path, statuses };
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const EVENT_ID = 17;
const DECOY_ID = 999;
const DECOY_KEY = "01J0000000000000000000ZZZZ";

export function capRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENT_ID,
    eventKey: key,
    title: "Fixture game night",
    game: "Chess",
    description: "Saved event copy",
    location: "Saved room",
    timezone: "UTC",
    capacity: 8,
    startsAt: new Date("2099-11-04T20:00:00Z"),
    endsAt: new Date("2099-11-04T22:00:00Z"),
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
    status: "published",
    rsvpOpen: true,
    createdBy: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    updatedAt: new Date("2026-01-01T12:00:00Z"),
    ...overrides,
  };
}

type Answer = {
  id: number;
  eventId: number;
  eventKey: string;
  userId: string;
  memberId: string | null;
  username: string | null;
  status: string;
  answeredAt: Date;
};

export type CapacityOptions = {
  capacity?: number | null;
  going?: number;
  maybe?: number;
  waitlisted?: number;
  notGoing?: number;
  /** Going rows with no user row at all: they still occupy seats. */
  namelessGoing?: number;
  noAnswers?: boolean;
  auditFails?: boolean;
  /** The Going-only aggregate read fails like a dropped connection. */
  aggregateFails?: boolean;
  status?: string;
  rsvpOpen?: boolean;
};

export type Statement = { sql: string; params: unknown[]; fields: string[] };

function like(pattern: string, value: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    let c = pattern[i]!;
    if (c === "\\") c = pattern[++i] ?? "\\";
    else if (c === "%") {
      regex += ".*";
      continue;
    } else if (c === "_") {
      regex += ".";
      continue;
    }
    regex += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`, "iu").test(value);
}

function outage(): Error {
  return Object.assign(new Error("fixture aggregate unavailable"), { code: "ECONNREFUSED" });
}

/** The Going-only aggregate, whatever its scoping: count(*) over rsvps with a
 * bound going predicate and no member search. The roster count only shares
 * this shape when the test itself facets to Going without a search, in which
 * case both truthfully read the same tally. */
export function isGoingAggregate(sql: string, params: unknown[]): boolean {
  if (!/^select count\(\*\) /.test(sql) || !sql.includes('from "rsvps"')) return false;
  const where = sql.split(" where ")[1]?.split(/ order by | limit /)[0] ?? "";
  const statusSlot = where.match(/"rsvps"\."status" = \$(\d+)/)?.[1];
  if (!statusSlot || params[Number(statusSlot) - 1] !== "going") return false;
  if (/ilike/i.test(where)) return false;
  return true;
}

export function capacityDb(options: CapacityOptions = {}) {
  const row = capRow({
    capacity: options.capacity === undefined ? 8 : options.capacity,
    status: (options.status ?? "published") as EventRow["status"],
    rsvpOpen: options.rsvpOpen ?? true,
  });
  const answers: Answer[] = [];
  let nextId = 1;
  if (!options.noAnswers) {
    const counts: [string, number][] = [
      ["going", options.going ?? 3],
      ["maybe", options.maybe ?? 2],
      ["waitlisted", options.waitlisted ?? 2],
      ["not_going", options.notGoing ?? 1],
    ];
    for (const [status, n] of counts) {
      const slot = statuses.indexOf(status as (typeof statuses)[number]);
      for (let i = 0; i < n; i++) {
        const userId = idFor(i, slot);
        answers.push({
          id: nextId++,
          eventId: EVENT_ID,
          eventKey: key,
          userId,
          memberId: userId,
          username: `${needle} ${status}-${i}`,
          status,
          answeredAt: new Date(Date.UTC(2026, 9, 1, 12, i, slot)),
        });
      }
    }
    for (let i = 0; i < (options.namelessGoing ?? 0); i++) {
      answers.push({
        id: nextId++,
        eventId: EVENT_ID,
        eventKey: key,
        userId: `10000000000009900${i}`,
        memberId: null,
        username: null,
        status: "going",
        answeredAt: new Date(Date.UTC(2026, 9, 2, 12, 0, i)),
      });
    }
    // Same answers on a different event must never affect totals or subjects.
    for (const [index, status] of ["going", "maybe"].entries()) {
      const userId = String(100000000000090000n + BigInt(index));
      answers.push({
        id: nextId++,
        eventId: DECOY_ID,
        eventKey: DECOY_KEY,
        userId,
        memberId: userId,
        username: needle,
        status,
        answeredAt: new Date("2026-10-02T12:00:00Z"),
      });
    }
  }
  const statements: Statement[] = [];
  const audits: Record<string, unknown>[] = [];
  const promoted: number[] = [];
  let mutations = 0;
  let updatedCapacity: number | null | undefined;
  const db = drizzle.mock() as unknown as Db;
  const session = (
    db as unknown as {
      session: {
        prepareQuery: (...args: never[]) => unknown;
        execute: (query: unknown) => Promise<unknown>;
        transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
      };
    }
  ).session;
  const dialect = new PgDialect();
  const handle = async (sql: string, params: unknown[], fields: string[]): Promise<unknown[]> => {
    statements.push({ sql, params: [...params], fields });
    if (sql.includes("set_config")) return [];
    if (sql.startsWith('insert into "member_data_access_logs"')) {
      if (options.auditFails) throw new Error("fixture audit unavailable");
      const columns = sql
        .match(/\((.*?)\) values/)![1]!
        .split(", ")
        .map((s) => s.replaceAll('"', ""));
      const values = sql.match(/values \((.*?)\)/)![1]!.split(", ");
      audits.push(
        Object.fromEntries(
          columns.map((c, i) => {
            const slot = values[i]!.match(/^\$(\d+)$/);
            return [c, slot ? params[Number(slot[1]) - 1] : null];
          }),
        ),
      );
      return [];
    }
    if (sql.startsWith('insert into "activity_log"')) {
      mutations++;
      return [];
    }
    if (sql.startsWith('update "events"')) {
      mutations++;
      const returning = sql.includes(" returning ");
      const capSlot = sql.match(/"capacity" = \$(\d+)/)?.[1];
      if (capSlot) {
        const value = params[Number(capSlot) - 1];
        updatedCapacity = typeof value === "number" ? value : null;
      }
      if (!returning) return [];
      return [{ ...row, capacity: updatedCapacity === undefined ? row.capacity : updatedCapacity }];
    }
    if (sql.startsWith('update "rsvps"')) {
      mutations++;
      if (params.includes("going")) {
        // Waitlist promotion settles the bound head ids to Going.
        const heads = new Set(params.filter((p): p is number => typeof p === "number"));
        for (const a of answers)
          if (a.eventId === EVENT_ID && a.status === "waitlisted" && heads.has(a.id)) {
            promoted.push(a.id);
            a.status = "going";
          }
      }
      return [];
    }
    if (!sql.startsWith("select ")) {
      mutations++;
      throw new Error(`unexpected fixture mutation: ${sql}`);
    }
    if (sql.includes('from "events"') && !sql.includes('from "rsvps"')) return [{ ...row }];
    if (!sql.includes('from "rsvps"')) throw new Error(`unsupported fixture read: ${sql}`);
    const where = sql.split(" where ")[1]?.split(/ order by | limit /)[0] ?? "";
    const param = (re: RegExp) => {
      const m = where.match(re);
      return m ? params[Number(m[1]) - 1] : undefined;
    };
    const eventKeyParam = param(/"events"\."event_key" = \$(\d+)/);
    // Numeric event_id scope (write-path goingCount and its read twin).
    const eventIdParam = param(/"rsvps"\."event_id" = \$(\d+)/);
    // Correlated subquery scope (fill filters): the row's own event.
    const correlated = /"rsvps"\."event_id" = "events"\."id"/.test(where);
    const status = param(/"rsvps"\."status" = \$(\d+)/);
    const search = param(/"users"\."username" ilike \$(\d+)/i);
    if (eventKeyParam === undefined && eventIdParam === undefined && !correlated)
      throw new Error("fixture requires bound event predicate");
    const scoped = answers.filter(
      (a) =>
        (correlated ||
          (eventKeyParam !== undefined && a.eventKey === eventKeyParam) ||
          (eventIdParam !== undefined && a.eventId === eventIdParam)) &&
        (status === undefined || a.status === status) &&
        (search === undefined || (a.username !== null && like(String(search), a.username))),
    );
    if (sql.startsWith("select count(*)")) {
      if (options.aggregateFails && isGoingAggregate(sql, params)) throw outage();
      return [{ n: scoped.length }];
    }
    // Waitlist line lock / promotion heads: waitlisted ids, FIFO, bounded by free seats.
    if (status === "waitlisted" && !sql.includes('"rsvps"."user_id"')) {
      const limit = sql.match(/ limit \$(\d+)/);
      const heads = scoped
        .slice()
        .sort((a, b) => a.id - b.id)
        .slice(0, limit ? Number(params[Number(limit[1]) - 1]) : scoped.length);
      return heads.map((a) => ({ id: a.id }));
    }
    const order = sql.match(
      /order by "rsvps"\."(status|updated_at)" (asc|desc), "rsvps"\."user_id"(?: asc)? limit/,
    );
    if (!order) throw new Error("fixture requires deterministic roster order");
    const selected = scoped.slice().sort((a, b) => {
      const left = order[1] === "status" ? a.status : a.answeredAt.toISOString();
      const right = order[1] === "status" ? b.status : b.answeredAt.toISOString();
      const primary = left < right ? -1 : left > right ? 1 : 0;
      return primary * (order[2] === "desc" ? -1 : 1) || a.userId.localeCompare(b.userId);
    });
    const limit = sql.match(/ limit \$(\d+)/);
    const offset = sql.match(/ offset \$(\d+)/);
    if (!limit) throw new Error("fixture refuses an unbounded roster page");
    const start = offset ? Number(params[Number(offset[1]) - 1]) : 0;
    return selected
      .slice(start, start + Number(params[Number(limit[1]) - 1]))
      .map(({ eventKey: _eventKey, eventId: _eventId, id: _id, ...a }) => a);
  };
  session.transaction = async (work) => work(db);
  session.prepareQuery = (
    query: { sql: string; params: unknown[] },
    fields?: { path: string[] }[],
  ) => ({
    setToken() {
      return this;
    },
    execute: async () =>
      handle(
        query.sql.replace(/\s+/g, " ").trim(),
        query.params,
        fields?.map((f) => f.path.join(".")) ?? [],
      ),
  });
  // tx.execute(statement) routes through the same handler, like production.
  session.execute = async (query: unknown) => {
    const built = dialect.sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]);
    return handle(built.sql.replace(/\s+/g, " ").trim(), [...built.params], []);
  };
  return {
    db,
    row,
    statements,
    audits,
    promoted,
    get mutations() {
      return mutations;
    },
    goingTally: () => answers.filter((a) => a.eventId === EVENT_ID && a.status === "going").length,
    /** A member answers Going after the page loaded; the locked save still sees it. */
    landGoing(userId = "100000000000000777") {
      answers.push({
        id: nextId++,
        eventId: EVENT_ID,
        eventKey: key,
        userId,
        memberId: userId,
        username: `${needle} late-going`,
        status: "going",
        answeredAt: new Date("2026-10-03T12:00:00Z"),
      });
    },
  };
}
export type CapacityFixture = ReturnType<typeof capacityDb>;

/** The real Kit load is executed, not a source-text pin. Passthrough bridges
 * keep the builder's new read bundling while request-scoped reads and the
 * member-read primitives stay on the outer instances (see the header note). */
export async function compileCapacityKit() {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const page = join(root, "web/src/routes/admin/events/[key]/+page.svelte");
  const load = join(root, "web/src/routes/admin/events/[key]/+page.server.ts");
  const layout = join(root, "web/src/routes/admin/+layout.server.ts");
  const realDb = join(root, "src/admin/db.ts");
  const realReads = join(root, "src/admin/reads.ts");
  const realEvents = join(root, "src/admin/store-event-reads.ts");
  const bridgeModules: Record<string, string> = {
    bridge: "export const state = {};",
    db: `export * from ${JSON.stringify(realDb)}; import {state} from "bridge"; export const dbFor=(...a)=>state.dbFor(...a);`,
    reads: `export * from ${JSON.stringify(realReads)}; import {state} from "bridge"; export const listRoster=(...a)=>state.listRoster(...a);`,
    event: `export * from ${JSON.stringify(realEvents)}; import {state} from "bridge"; export const getEvent=(...a)=>state.getEvent(...a);`,
    // No passthrough here: a second member-reads copy would mint permits in a
    // boundary the request's adapter never sees. Every name the bundled reads
    // use resolves to the outer instance instead.
    members: `import {state} from "bridge"; export const nonSensitiveRead=(...a)=>state.nonSensitiveRead(...a); export const keyedMemberRead=(...a)=>state.keyedMemberRead(...a); export const declareMemberResult=(...a)=>state.declareMemberResult(...a); export const refuseMemberRead=(...a)=>state.refuseMemberRead(...a); export const captureMemberKeys=(...a)=>state.captureMemberKeys(...a); export const memberQueryPermit=(...a)=>state.memberQueryPermit(...a); export const memberReadActive=(...a)=>state.memberReadActive(...a);`,
    kit: "export function error(status,message){throw Object.assign(new Error(message),{status});} export function redirect(status,location){throw Object.assign(new Error('redirect'),{status,location});}",
  };
  // env is exported as an object before configure() runs, so use the fixed safe fixture.
  const { env } = await import("./member-data");
  bridgeModules.env = `export const env=${JSON.stringify(env)};`;
  const built = await build({
    stdin: {
      contents: `import {state} from "bridge"; import {load} from ${JSON.stringify(load)}; import {load as layout} from ${JSON.stringify(layout)}; import P from ${JSON.stringify(page)}; import {render} from "svelte/server"; export function configure(deps){Object.assign(state,deps);} export {load,layout}; export const html=(data)=>render(P,{props:{data}}).body;`,
      resolveDir: root,
      sourcefile: "event-capacity-ssr.mjs",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    logLevel: "silent",
    plugins: [
      {
        name: "capacity-fixture-bindings",
        setup(p) {
          p.onResolve({ filter: /^bridge$/ }, () => ({
            path: "bridge",
            namespace: "capacity-fixture",
          }));
          for (const [filter, name] of [
            [/^@sveltejs\/kit$/, "kit"],
            [/^cloudflare:workers$/, "env"],
            [/src\/admin\/db$/, "db"],
            [/src\/admin\/reads$/, "reads"],
            [/src\/admin\/store-event-reads$/, "event"],
          ] as const)
            p.onResolve({ filter }, () => ({ path: name, namespace: "capacity-fixture" }));
          // Member-reads arrives both as a deep relative specifier (the load)
          // and as a sibling relative specifier (the re-exported real reads),
          // so match the specifier shape instead of the resolved path.
          p.onResolve({ filter: /member-reads/ }, (args) =>
            /(^|\/)\.\.?\/member-reads$/.test(args.path) || /src\/member-reads$/.test(args.path)
              ? { path: "members", namespace: "capacity-fixture" }
              : null,
          );
          p.onLoad({ filter: /.*/, namespace: "capacity-fixture" }, ({ path }) => ({
            contents: bridgeModules[path]!,
            loader: "js",
            resolveDir: root,
          }));
          p.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            }).js.code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
  );
  compiled.configure({
    dbFor,
    listRoster,
    getEvent,
    nonSensitiveRead,
    keyedMemberRead,
    declareMemberResult,
    refuseMemberRead,
    captureMemberKeys,
    memberQueryPermit,
    memberReadActive,
  });
  return compiled as {
    load: (event: {
      parent: () => Promise<unknown>;
      params: { key: string };
      url: URL;
      setHeaders: (headers: Record<string, string>) => void;
    }) => Promise<unknown>;
    layout: (event: {
      locals: KitLocals;
      url: URL;
      setHeaders: (headers: Record<string, string>) => void;
    }) => Promise<unknown>;
    html: (data: unknown) => string;
    configure: (deps: Record<string, unknown>) => void;
  };
}
export type CapacityKit = Awaited<ReturnType<typeof compileCapacityKit>>;

/** The capacity field block both twins render: label, input, hint, snapshot,
 * advice and drilldown. Depth-counted so nested snapshot/advice markup stays
 * inside. Throws when the edit form carries no capacity input. */
export function capacityField(html: string): string {
  const inputAt = html.indexOf('name="capacity"');
  if (inputAt === -1) throw new Error("real route did not render the capacity input");
  const openTag = '<div class="field">';
  const start = html.lastIndexOf(openTag, inputAt);
  if (start === -1) throw new Error("capacity input is not inside a field block");
  let depth = 0;
  let cursor = start;
  let end = -1;
  while (cursor < html.length) {
    const nextOpen = html.indexOf("<div", cursor);
    const nextClose = html.indexOf("</div>", cursor);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cursor = nextOpen + 4;
    } else {
      depth--;
      cursor = nextClose + 6;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
  }
  if (end === -1) throw new Error("capacity field block never closes");
  const field = html.slice(start, end);
  // Strip Svelte hydration comments by walking comment tokens: a comment ends
  // at the first `-->`. No regex rewrite, so CodeQL
  // incomplete-multi-character-sanitization does not apply.
  let out = "";
  let index = 0;
  while (index < field.length) {
    const start = field.indexOf("<!--", index);
    if (start === -1) {
      out += field.slice(index);
      break;
    }
    out += field.slice(index, start);
    const end = field.indexOf("-->", start + 4);
    index = end === -1 ? field.length : end + 3;
  }
  return out;
}
