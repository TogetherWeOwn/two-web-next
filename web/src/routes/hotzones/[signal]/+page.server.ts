import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { alertRequestError } from "../../../../../src/alerts";
import { parseSeasonParam } from "../../../../../src/hotzones/season";
// The season import stays above the vocabulary import: this binding mirrors
// the Hono order (season grammar before the signal check), and the order pin
// reads the source top to bottom.
import { isHotzoneSignal } from "../../../../../src/hotzones/aggregates";
import { loadHotzoneSignalData } from "../../../../../src/kit-hotzones";
import { parseDayParam } from "../../../../../src/hotzones/day";
import {
  renderHotzoneDay,
  renderHotzoneGrid,
  renderPeriodPicker,
} from "../../../../../src/hotzones/pages";

// Locked signal vocabulary: joins | voice | games exactly, via the shared
// predicate. Any other segment 404s at this binding, never a grid; the helper
// re-checks it for its own callers.

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Thin binding over the tested helper (src/kit-hotzones.ts): the helper owns
// the season/signal grammar, the reads, the board-view log and the cache
// policy; this binding owns the branded status mapping (400 season grammar,
// 404 unknown signal, 503 outage) and the grid rendering.
export const load: PageServerLoad = async ({ params, url, locals, setHeaders }) => {
  // Hono answers the season grammar before the signal vocabulary
  // (src/hotzones/routes.tsx); keep that order here too. The helper
  // re-checks both for its own callers. These pre-checks bypass the helper,
  // so they stamp the helper's no-store headers themselves: exactly one
  // setHeaders call fires per path either way.
  if (!parseSeasonParam(url.searchParams.get("season"))) {
    setHeaders({ "cache-control": "private, no-store" });
    error(400, "Unknown season");
  }
  if (!isHotzoneSignal(params.signal)) {
    setHeaders({ "cache-control": "private, no-store" });
    error(404, "Not found");
  }
  try {
    const data = await loadHotzoneSignalData({
      env,
      seasonParam: url.searchParams.get("season"),
      signalParam: params.signal,
      setHeaders,
      dbForFn: dbFor,
      requestId: locals.requestId,
    });
    // A repeated or unknown `day` means the full week, exactly as on Hono.
    const day = parseDayParam(url.searchParams.getAll("day"));
    const caption = data.estimated
      ? `Season-independent seeded estimate of ${data.signal} activity`
      : `Join activity for season ${data.season}`;
    return {
      signal: data.signal,
      season: data.season,
      day,
      gridHtml: day
        ? renderHotzoneDay(data.cells, caption, day)
        : await renderHotzoneGrid(data.cells, caption),
      total: data.total,
      eventCount: data.eventCount,
      retentionNote: data.retentionNote,
      estimated: data.estimated,
      appUrl: data.appUrl,
      periodPickerHtml: renderPeriodPicker(`/hotzones/${data.signal}`, data.season, { day }),
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) error(400, "Unknown season");
    if (status === 404) error(404, "Not found");
    // The helper already alerted on unbranded read failures; alert here only
    // for failures the helper could not see (grid rendering).
    if (typeof status !== "number")
      alertRequestError(err, {
        method: "GET",
        route: "/hotzones/:signal",
        requestId: locals.requestId,
      });
    error(503, "Hot zones temporarily unavailable");
  }
};
