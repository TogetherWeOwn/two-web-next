import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../src/admin/db";
import { alertRequestError } from "../../../../src/alerts";
import { loadHotzonesIndexData } from "../../../../src/kit-hotzones";
import { renderHotzoneGrid, renderPeriodPicker } from "../../../../src/hotzones/pages";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Thin binding over the tested helper (src/kit-hotzones.ts): the helper owns
// the reads, the board-view log and the cache policy; this binding owns the
// branded status mapping (400 season grammar, 503 outage) and the grid
// rendering, mirroring web/src/routes/events/past/+page.server.ts.
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  try {
    const data = await loadHotzonesIndexData({
      env,
      seasonParam: url.searchParams.get("season"),
      setHeaders,
      dbForFn: dbFor,
    });
    return {
      season: data.season,
      joinsHtml: await renderHotzoneGrid(
        data.joins.cells,
        `Join activity for season ${data.season}`,
      ),
      joinsTotal: data.joins.total,
      eventCount: data.joins.eventCount,
      gatherings: data.gatherings,
      voiceHtml: await renderHotzoneGrid(
        data.voice.cells,
        "Season-independent seeded estimate of voice activity",
      ),
      gamesHtml: await renderHotzoneGrid(
        data.games.cells,
        "Season-independent seeded estimate of games activity",
      ),
      retentionNote: data.retentionNote,
      appUrl: data.appUrl,
      periodPickerHtml: renderPeriodPicker("/hotzones", data.season),
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) error(400, "Unknown season");
    // The helper already alerted on unbranded read failures; alert here only
    // for failures the helper could not see (grid rendering), so a code bug
    // never becomes a silent 503.
    if (typeof status !== "number") alertRequestError(err, { method: "GET", route: "/hotzones" });
    error(503, "Hot zones temporarily unavailable");
  }
};
