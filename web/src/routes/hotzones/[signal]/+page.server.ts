import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { loadHotzoneSignalData } from "../../../../../src/kit-hotzones";
import type { HotzoneSignal } from "../../../../../src/hotzones/aggregates";
import { renderHotzoneGrid } from "../../../../../src/hotzones/pages";

// Locked signal vocabulary: joins | voice | games exactly. Any other segment
// 404s at this binding, never a grid; the helper re-checks it for its own
// callers.
const SIGNALS: HotzoneSignal[] = ["joins", "voice", "games"];

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Thin binding over the tested helper (src/kit-hotzones.ts): the helper owns
// the season/signal grammar, the reads, the board-view log and the cache
// policy; this binding owns the branded status mapping (400 season grammar,
// 404 unknown signal, 503 outage) and the grid rendering.
export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  if (!SIGNALS.includes(params.signal as HotzoneSignal)) error(404, "Not found");
  try {
    const data = await loadHotzoneSignalData({
      env,
      seasonParam: url.searchParams.get("season"),
      signalParam: params.signal,
      setHeaders,
      dbForFn: dbFor,
    });
    return {
      signal: data.signal,
      season: data.season,
      gridHtml: await renderHotzoneGrid(
        data.cells,
        data.estimated
          ? `Estimated ${data.signal} activity for season ${data.season}`
          : `Join activity for season ${data.season}`,
      ),
      total: data.total,
      eventCount: data.eventCount,
      retentionNote: data.retentionNote,
      estimated: data.estimated,
      appUrl: data.appUrl,
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) error(400, "Unknown season");
    if (status === 404) error(404, "Not found");
    error(503, "Hot zones temporarily unavailable");
  }
};
