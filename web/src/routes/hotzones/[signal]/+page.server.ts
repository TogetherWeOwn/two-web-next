import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import {
  isHotzoneSignal,
  loadJoinsGrid,
  priorGrid,
  type HotzoneSignal,
} from "../../../../../src/hotzones/aggregates";
import { parseSeasonParam } from "../../../../../src/hotzones/season";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Locked signal vocabulary: joins | voice | games exactly. Any other segment
// 404s, never a grid. Same reads and cache policy as the Hono handler.
const SIGNALS: HotzoneSignal[] = ["joins", "voice", "games"];

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  const season = parseSeasonParam(url.searchParams.get("season"));
  if (!season) error(400, "Unknown season");
  const signal = params.signal;
  if (!isHotzoneSignal(signal) || !SIGNALS.includes(signal)) error(404, "Not found");
  const label = season.kind === "all" ? "all" : season.label;
  const db = await dbFor({ env });
  if (signal === "joins") {
    const joins = await loadJoinsGrid(db, season);
    setHeaders({ "cache-control": "public, max-age=300" });
    return {
      signal,
      season: label,
      cells: joins.cells,
      total: joins.total,
      eventCount: joins.eventCount,
      estimated: false,
      appUrl: env.APP_URL,
    };
  }
  const prior = priorGrid(signal);
  setHeaders({ "cache-control": "public, max-age=300" });
  return {
    signal,
    season: label,
    cells: prior.cells,
    total: prior.total,
    eventCount: 0,
    estimated: true,
    appUrl: env.APP_URL,
  };
};
