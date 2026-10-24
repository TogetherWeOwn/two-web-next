import type { Db } from "./db/index";
import type { Env } from "./env";
import { alertRequestError } from "./alerts";
import {
  isHotzoneSignal,
  joinsRetentionNote,
  loadJoinsGrid,
  priorGrid,
  type HeatGrid,
  type HotzoneSignal,
} from "./hotzones/aggregates";
import { recordBoardView } from "./hotzones/board-log";
import { parseSeasonParam, type SeasonWindow } from "./hotzones/season";
import { kitPublicReadGuard, type KitPublicReadGuard } from "./kit-past-events";

// Framework-free core of the Kit hot-zone loads
// (web/src/routes/hotzones/+page.server.ts and
// web/src/routes/hotzones/[signal]/+page.server.ts). The SvelteKit modules
// stay thin bindings over this helper so the root Vitest suite can pin every
// branch without transforming SvelteKit code, mirroring src/kit-past-events.ts.
// Behaviour preserved from the Hono handlers (src/hotzones/routes.tsx):
// season grammar answers 400 before any read, unknown signals 404, the joins
// aggregate answers a branded 503 on a database outage (never a Kit 500), and
// every served board records its anonymous board view fail-open. Exactly one
// setHeaders call per path: SvelteKit throws `header_already_set` on a
// double-set, so the binding must not set headers again on a throw.

export type HotzonesGrid = { cells: HeatGrid; total: number; eventCount: number };
export type LoadJoinsGrid = (db: Db | null, window: SeasonWindow) => Promise<HotzonesGrid>;
export type RecordBoardView = (
  db: Db | null,
  opts: { boardKey: string; scope: string; season: string; resultCount: number },
  deadlineMs?: number,
  requestId?: unknown,
) => Promise<void>;

export interface HotzonesLoadArgs {
  env: Env;
  seasonParam: string | null;
  setHeaders: (headers: Record<string, string>) => void;
  dbForFn: (c: { env: Env }) => Promise<Db | null>;
  loadJoinsGridFn?: LoadJoinsGrid;
  recordBoardViewFn?: RecordBoardView;
  /** Optional correlation id for the board-view record; omitted when the caller has none (see the runbook's Kit-omission caveat). */
  requestId?: string | null;
}

function branded(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const NO_STORE = "private, no-store";

/** Fresh no-store headers per path: every error outcome carries explicit no-store like its Hono twin. */
function noStoreHeaders(): Record<string, string> {
  return { "cache-control": NO_STORE };
}

/** Season grammar failure: the Kit binding maps this to error(400). */
export function hotzonesBadSeason(): Error & { status: number } {
  return branded("Unknown season", 400);
}

/** Unknown signal segment: the Kit binding maps this to error(404). */
export function hotzoneSignalNotFound(): Error & { status: number } {
  return branded("Not found", 404);
}

/** Branded outage marker: the Kit binding maps every throw to error(503). */
export function hotzonesUnavailable(): Error & { status: number } {
  return branded("Hot zones temporarily unavailable", 503);
}

function seasonOrThrow(
  seasonParam: string | null,
  setHeaders: (headers: Record<string, string>) => void,
): { window: SeasonWindow; label: string } {
  const window = parseSeasonParam(seasonParam);
  if (!window) {
    setHeaders(noStoreHeaders());
    throw hotzonesBadSeason();
  }
  return { window, label: window.kind === "all" ? "all" : window.label };
}

// A code bug (no branded status) must never look like a downstream outage:
// emit the leak-free error.alert diagnostic before mapping to the branded
// 503, mirroring the Hono member-read boundary (src/member-reads.ts). Branded
// throws (400/404/503 from nested helpers) pass through with the same no-store
// headers so the binding maps them once and exactly one setHeaders call fires
// per path.
function reportLoadFailure(err: unknown, args: HotzonesLoadArgs, route: string): never {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    args.setHeaders(noStoreHeaders());
    throw err;
  }
  alertRequestError(err, { method: "GET", route });
  args.setHeaders(noStoreHeaders());
  throw hotzonesUnavailable();
}

async function dbOrUnavailable(args: HotzonesLoadArgs, route: string): Promise<{ db: Db | null }> {
  try {
    return { db: await args.dbForFn({ env: args.env }) };
  } catch (err) {
    reportLoadFailure(err, args, route);
  }
}

async function joinsOrUnavailable(
  args: HotzonesLoadArgs,
  db: Db | null,
  window: SeasonWindow,
  route: string,
): Promise<HotzonesGrid> {
  try {
    return await (args.loadJoinsGridFn ?? loadJoinsGrid)(db, window);
  } catch (err) {
    reportLoadFailure(err, args, route);
  }
}

async function record(
  args: HotzonesLoadArgs,
  db: Db | null,
  opts: { boardKey: string; scope: string; season: string; resultCount: number },
): Promise<void> {
  // Fail-open, exactly as on the Hono handlers: a logging failure never
  // blocks or breaks the board. A caller-supplied request id rides along to
  // the record call; none supplied means none carried (no new read to mint one).
  await (args.recordBoardViewFn ?? recordBoardView)(db, opts, undefined, args.requestId).catch(
    () => {},
  );
}

export async function loadHotzonesIndexData(args: HotzonesLoadArgs): Promise<{
  season: string;
  joins: HotzonesGrid;
  voice: { cells: HeatGrid; total: number };
  games: { cells: HeatGrid; total: number };
  retentionNote: string | null;
  appUrl: string;
}> {
  const { window, label } = seasonOrThrow(args.seasonParam, args.setHeaders);
  const { db } = await dbOrUnavailable(args, "/hotzones");
  const joins = await joinsOrUnavailable(args, db, window, "/hotzones");
  await record(args, db, {
    boardKey: "hotzones",
    scope: "overall",
    season: label,
    resultCount: joins.total,
  });
  args.setHeaders({ "cache-control": "public, max-age=300", vary: "Cookie" });
  return {
    season: label,
    joins,
    voice: priorGrid("voice"),
    games: priorGrid("games"),
    retentionNote: joinsRetentionNote(window),
    appUrl: args.env.APP_URL,
  };
}

export async function loadHotzoneSignalData(
  args: HotzonesLoadArgs & { signalParam: string },
): Promise<{
  signal: HotzoneSignal;
  season: string;
  cells: HeatGrid;
  total: number;
  eventCount: number;
  retentionNote: string | null;
  estimated: boolean;
  appUrl: string;
}> {
  const { window, label } = seasonOrThrow(args.seasonParam, args.setHeaders);
  const signal = args.signalParam;
  if (!isHotzoneSignal(signal)) {
    args.setHeaders(noStoreHeaders());
    throw hotzoneSignalNotFound();
  }
  const { db } = await dbOrUnavailable(args, "/hotzones/:signal");
  if (signal === "joins") {
    const joins = await joinsOrUnavailable(args, db, window, "/hotzones/:signal");
    await record(args, db, {
      boardKey: "hotzones/joins",
      scope: "overall",
      season: label,
      resultCount: joins.total,
    });
    args.setHeaders({ "cache-control": "public, max-age=300", vary: "Cookie" });
    return {
      signal,
      season: label,
      cells: joins.cells,
      total: joins.total,
      eventCount: joins.eventCount,
      retentionNote: joinsRetentionNote(window),
      estimated: false,
      appUrl: args.env.APP_URL,
    };
  }
  const prior = priorGrid(signal);
  await record(args, db, {
    boardKey: `hotzones/${signal}`,
    scope: "overall",
    season: label,
    resultCount: prior.total,
  });
  args.setHeaders({ "cache-control": "public, max-age=300", vary: "Cookie" });
  return {
    signal,
    season: label,
    cells: prior.cells,
    total: prior.total,
    eventCount: 0,
    retentionNote: null,
    estimated: true,
    appUrl: args.env.APP_URL,
  };
}

/** Apply the shared public-read budget around Kit hot-zone SSR. */
export async function dispatchHotzonesRequest(
  request: Request,
  env: Env,
  render: () => Promise<Response>,
  guard: KitPublicReadGuard = kitPublicReadGuard,
): Promise<Response> {
  // Season grammar first, mirroring the Hono handlers: a bad season reaches
  // the load's 400 without spending. Unknown signals never reach this
  // wrapper: the manifest lists concrete signal paths only, so anything else
  // falls through to the Hono 404.
  if (!parseSeasonParam(new URL(request.url).searchParams.get("season"))) return render();
  const limited = await guard(request, env);
  return limited ?? render();
}
