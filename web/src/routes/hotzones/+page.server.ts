import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../src/admin/db";
import { joinsRetentionNote, loadJoinsGrid, priorGrid } from "../../../../src/hotzones/aggregates";
import { parseSeasonParam } from "../../../../src/hotzones/season";
import { renderHotzoneGrid } from "../../../../src/hotzones/pages";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/hotzones/routes.tsx).
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  const season = parseSeasonParam(url.searchParams.get("season"));
  if (!season) error(400, "Unknown season");
  const label = season.kind === "all" ? "all" : season.label;
  const db = await dbFor({ env });
  const joins = await loadJoinsGrid(db, season);
  const voice = priorGrid("voice");
  const games = priorGrid("games");
  setHeaders({ "cache-control": "public, max-age=300" });
  return {
    season: label,
    joinsHtml: await renderHotzoneGrid(joins.cells, `Join activity for season ${label}`),
    joinsTotal: joins.total,
    eventCount: joins.eventCount,
    voiceHtml: await renderHotzoneGrid(voice.cells, `Estimated voice activity for season ${label}`),
    gamesHtml: await renderHotzoneGrid(games.cells, `Estimated games activity for season ${label}`),
    retentionNote: joinsRetentionNote(season),
    appUrl: env.APP_URL,
  };
};
