// Hot-zone Hono routes.
//
// GET /hotzones (index, links all 3 signals) + GET /hotzones/:signal for
// joins|voice|games exactly; unknown segments 404, never a grid. `?season=`
// uses the shared pure date-window grammar; anything else answers 400 before
// any aggregation (also on signal views). Same aggregate reads the Kit load
// functions call, per web/src/routes/events/past/ precedent.
import { dbFor } from "../admin/db";
import { BadRequestPage } from "../error-pages";
import { publicReadGuard, type App, type Ctx } from "../events/routes-shared";
import { HotzoneSignalPage, HotzonesIndexPage } from "./pages";
import { isHotzoneSignal, joinsRetentionNote, loadJoinsGrid, priorGrid } from "./aggregates";
import { recordBoardView } from "./board-log";
import { parseSeasonParam, seasonLabel } from "./season";

const badSeason = (c: Ctx) => {
  c.header("cache-control", "no-store, private");
  return c.html(<BadRequestPage />, 400);
};

async function renderIndex(c: Ctx) {
  const raw = c.req.query("season");
  const window = parseSeasonParam(raw ?? null);
  if (!window) return badSeason(c);
  const limited = await publicReadGuard(c);
  if (limited) return limited;
  const label = window.kind === "all" ? "all" : window.label;
  const db = await dbFor(c);
  const joins = await loadJoinsGrid(db, window);
  const voice = priorGrid("voice");
  const games = priorGrid("games");
  // Anonymous view log (fail-open, never blocks the board).
  if (db) {
    await recordBoardView(
      db,
      {
        boardKey: "hotzones",
        scope: "overall",
        season: label,
        resultCount: joins.total,
      },
      undefined,
      c.get("requestId"),
    ).catch(() => {});
  }
  c.header("cache-control", "public, max-age=300");
  c.header("vary", "Cookie");
  return c.html(
    <HotzonesIndexPage
      appUrl={c.env.APP_URL}
      season={label}
      joins={joins.cells}
      joinsTotal={joins.total}
      eventCount={joins.eventCount}
      gatherings={joins.gatherings}
      voice={voice.cells}
      games={games.cells}
      retentionNote={joinsRetentionNote(window)}
    />,
  );
}

async function renderSignal(c: Ctx) {
  const raw = c.req.query("season");
  const window = parseSeasonParam(raw ?? null);
  if (!window) return badSeason(c);
  const signal = c.req.param("signal") ?? "";
  if (!isHotzoneSignal(signal)) return c.notFound();
  const limited = await publicReadGuard(c);
  if (limited) return limited;
  const label = window.kind === "all" ? "all" : window.label;
  void seasonLabel(raw ?? null);
  const db = await dbFor(c);
  if (signal === "joins") {
    const joins = await loadJoinsGrid(db, window);
    if (db) {
      await recordBoardView(
        db,
        {
          boardKey: "hotzones/joins",
          scope: "overall",
          season: label,
          resultCount: joins.total,
        },
        undefined,
        c.get("requestId"),
      ).catch(() => {});
    }
    c.header("cache-control", "public, max-age=300");
    c.header("vary", "Cookie");
    return c.html(
      <HotzoneSignalPage
        appUrl={c.env.APP_URL}
        signal={signal}
        season={label}
        cells={joins.cells}
        total={joins.total}
        eventCount={joins.eventCount}
        gatherings={joins.gatherings}
        retentionNote={joinsRetentionNote(window)}
      />,
    );
  }
  const prior = priorGrid(signal);
  if (db) {
    await recordBoardView(
      db,
      {
        boardKey: `hotzones/${signal}`,
        scope: "overall",
        season: label,
        resultCount: prior.total,
      },
      undefined,
      c.get("requestId"),
    ).catch(() => {});
  }
  c.header("cache-control", "public, max-age=300");
  c.header("vary", "Cookie");
  return c.html(
    <HotzoneSignalPage
      appUrl={c.env.APP_URL}
      signal={signal}
      season={label}
      cells={prior.cells}
      total={prior.total}
    />,
  );
}

export function registerHotzoneRoutes(app: App): void {
  app.get("/hotzones", renderIndex);
  app.get("/hotzones/:signal", renderSignal);
}
