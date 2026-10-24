// Calendar/collection event routes: GET /events and GET /events/past.
// Split out of src/events/routes.tsx; behavior unchanged.
import { dbFor } from "../admin/db";
import { isDatabaseUnavailable } from "../db/errors";
import { databaseUnavailable } from "../errors";
import { inviteDestination } from "../invite";
import { takeJoinResult, readJoinResult } from "../return-journey";
import { loadCalendarPageModel, resolveCalendarInput } from "./page-models.server";
import {
  ANON_EVENTS_TTL_MS,
  ANON_PAST_TTL_MS,
  anonCacheGeneration,
  anonCacheSource,
  anonEventsKey,
  anonPastKey,
  isAnonCacheEligible,
  readAnonCache,
  writeAnonCache,
} from "./anon-cache";
import { discordEventsSource } from "./discord-transients";
import { listPast, normalizePastPage } from "./reads";
import { matchQuery } from "./search-log";
import { EventsCalendarPage, EventsSearchTooLongPage, PastEventsPage } from "./pages";
import { eventsUnavailable, publicReadGuard, type App, type SessionReader } from "./routes-shared";

export function registerCalendarRoutes(
  app: App,
  readSession: SessionReader,
  readFragmentSession: SessionReader,
): void {
  app.get("/events", async (c) => {
    const input = resolveCalendarInput({
      q: c.req.query("q"),
      game: c.req.query("game"),
      view: c.req.query("view"),
      past: c.req.query("past"),
      page: c.req.query("page"),
      event: c.req.query("event"),
      month: c.req.query("month"),
    });
    if (input.queryTooLong) {
      c.header("cache-control", "no-store, private");
      return c.html(<EventsSearchTooLongPage appUrl={c.env.APP_URL} />, 422);
    }
    let phases = c.get("calendarPhaseRecorder");
    const limited = await (phases
      ? phases.measure("public_read_guard", () => publicReadGuard(c))
      : publicReadGuard(c));
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) {
      return c.req.header("x-two-island") === "events-calendar"
        ? eventsUnavailable(c)
        : databaseUnavailable(c);
    }
    let session;
    try {
      session = await (c.req.header("x-two-island") === "events-calendar"
        ? readFragmentSession(c)
        : readSession(c));
    } catch (err) {
      // Rotation errors arrive already normalized (classified outage or plain
      // Error) and answer 503, never a silent guest or a 500; named non-outage
      // exceptions are genuine programming errors, so they rethrow like home.
      // Class-only log: driver messages can carry DSN fragments.
      if (err instanceof Error && err.name !== "Error" && !isDatabaseUnavailable(err)) throw err;
      console.error("events calendar could not resolve the session; refusing.", {
        exception: err instanceof Error ? err.constructor.name : "unknown",
      });
      return databaseUnavailable(c);
    }
    // Admission precedes session resolution. Discard its provisional timing
    // once a session is known: signed-in requests retain the original log shape.
    if (session !== null) {
      phases = undefined;
      c.set("calendarPhaseRecorder", undefined);
    }
    const now = new Date();

    const { searching } = input;
    // Anonymous shared entry (N6 retire): only a cookieless, session-free,
    // search-free render with no pending join flash may serve shared bytes.
    // The peek reads without consuming; the miss path below still consumes
    // exactly once, and island swaps keep their pending value like today.
    const island = c.req.header("x-two-island") === "events-calendar";
    const flashed = island ? null : await readJoinResult(c);
    const anonEligible = isAnonCacheEligible({
      method: c.req.method,
      hasCookie: c.req.header("cookie") !== undefined,
      hasSession: session !== null,
      searching,
      flashed: flashed !== null,
    });
    const anonSource = anonEligible ? anonCacheSource(c.env) : null;
    let anonKey: string | null = null;
    if (anonSource) {
      let pathAndSearch = "";
      try {
        const u = new URL(c.req.url);
        pathAndSearch = u.pathname + u.search;
      } catch {
        pathAndSearch = "/events";
      }
      anonKey = anonEventsKey(c.req.method, pathAndSearch, island);
      const hit = readAnonCache(anonKey, anonSource);
      if (hit) {
        // Remaining TTL, not the stored full window: a browser must never
        // extend the entry past its origin expiry.
        c.header(
          "cache-control",
          hit.cacheControl.replace(/max-age=\d+/, `max-age=${hit.maxAgeSeconds}`),
        );
        if (hit.vary) c.header("vary", hit.vary);
        return phases
          ? phases.measure("render_cache", () => c.html(hit.body, hit.status as 200))
          : c.html(hit.body, hit.status as 200);
      }
    }
    // Retire generation before the first render read: a publish, edit or RSVP
    // that commits (and retires) while this render awaits its reads must stop
    // the stale bytes from settling below.
    const anonGen = anonSource ? anonCacheGeneration() : 0;
    const loadModel = () =>
      loadCalendarPageModel({
        db,
        input,
        includeDrafts: session?.moderator ?? false,
        discord: discordEventsSource(c.env),
        now,
        requestId: c.get("requestId"),
        phases,
      });
    const model = await (phases ? phases.measure("calendar_model", loadModel) : loadModel());
    const {
      state,
      upcoming,
      past: localPast,
      pastMayBeTruncated,
      zone,
      totalPages,
      emptyState,
      robots,
      discordFailed,
      games,
      gameFilter,
    } = model;

    // One-shot join confirmation (legacy join_result flash): /events is a
    // join-CTA landing (`/join?next=/events`), so it consumes and renders the
    // banner exactly once like /, /join, /profile and /e/:key (TOG-10356
    // review). Island fragment swaps must not consume it: the banner renders
    // outside the swapped zones, so a fragment would eat the flash without
    // ever displaying it — the pending value survives for the next full load.
    // `island` is hoisted above the anonymous-cache lookup; `flashed` peeked
    // there, so this consume is a no-op on the cacheable path.
    const joinResult = island ? null : await takeJoinResult(c);
    // Search analytics must run per request, not only on shared-cache misses.
    c.header(
      "cache-control",
      session || searching || joinResult ? "private, no-store" : "public, max-age=60",
    );
    // First-fetch header for the same duplicates the in-body meta covers on
    // cache hits (see `robots` above).
    if (robots !== undefined) c.header("x-robots-tag", "noindex, follow");
    c.header("vary", "Cookie, X-Two-Island");
    // Guest sign-in links carry this page as ?next= so the OAuth round trip
    // lands back here (TOG-10356). Rooted pathname + search only — the
    // journey guard re-validates before any redirect, so a hostile query can
    // at worst fall back to the default landing, never off-app.
    let loginReturnTo: string | null = null;
    try {
      const u = new URL(c.req.url);
      loginReturnTo = u.pathname + u.search;
    } catch {
      loginReturnTo = "/events";
    }
    const render = async () => {
      const response = await c.html(
        <EventsCalendarPage
          state={state}
          upcoming={upcoming}
          past={localPast}
          pastMayBeTruncated={pastMayBeTruncated}
          zone={zone}
          now={now}
          totalPages={totalPages}
          emptyState={emptyState}
          robots={robots}
          discordFailed={discordFailed}
          games={games}
          gameFilter={gameFilter}
          member={session?.member ?? false}
          inviteUrl={inviteDestination(c.env.DISCORD_INVITE_URL)}
          appUrl={c.env.APP_URL}
          loginReturnTo={loginReturnTo}
          joinResult={joinResult}
          markdownAlternate="/events.md"
        />,
      );
      // Settle the shared entry only from an anonymous 200: the header guard
      // above already forced private on session/search/flash, so a `public`
      // prefix re-checks that no viewer state slipped into shared bytes. Buffer
      // the candidate before the final generation comparison so a retire that
      // lands while clone().text() is in flight drops the stale bytes; the
      // compare-and-write is synchronous, so it is atomic within the isolate.
      if (anonSource && anonKey && response.status === 200) {
        const cacheControl = response.headers.get("cache-control");
        if (cacheControl?.startsWith("public")) {
          const body = await response.clone().text();
          if (anonCacheGeneration() === anonGen) {
            writeAnonCache(
              anonKey,
              anonSource,
              {
                status: 200,
                cacheControl,
                vary: response.headers.get("vary"),
                body,
              },
              ANON_EVENTS_TTL_MS,
            );
          }
        }
      }
      return response;
    };
    return phases ? phases.measure("render_cache", render) : render();
  });

  app.get("/events/past", async (c) => {
    const input = resolveCalendarInput({ q: c.req.query("q") });
    if (input.queryTooLong) {
      c.header("cache-control", "no-store, private");
      return c.html(<EventsSearchTooLongPage appUrl={c.env.APP_URL} archive />, 422);
    }
    const q = matchQuery(input.q);
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) {
      return c.req.header("x-two-island") === "past-events"
        ? eventsUnavailable(c)
        : databaseUnavailable(c);
    }
    const page = normalizePastPage(Number.parseInt(c.req.query("page") ?? "1", 10));
    // Anonymous shared entry (N6 retire): the archive renders no session, no
    // flash and no RSVP controls. Only search-free cookieless renders share bytes.
    // Only data pages settle — empty and out-of-range renders stay uncached
    // so a fresh archive never pins a stale "never ran" state, and keys stay
    // bounded.
    const pastEligible = isAnonCacheEligible({
      method: c.req.method,
      hasCookie: c.req.header("cookie") !== undefined,
      hasSession: false,
      searching: input.searching,
      flashed: false,
    });
    const pastSource = pastEligible ? anonCacheSource(c.env) : null;
    const pastKey = pastEligible ? anonPastKey(c.req.method, page) : null;
    if (pastSource && pastKey) {
      const hit = readAnonCache(pastKey, pastSource);
      if (hit) {
        c.header(
          "cache-control",
          hit.cacheControl.replace(/max-age=\d+/, `max-age=${hit.maxAgeSeconds}`),
        );
        if (hit.vary) c.header("vary", hit.vary);
        return c.html(hit.body, hit.status as 200);
      }
    }
    // Same retire-generation guard as `/events`: an edit that commits while
    // this archive render awaits its read must stop stale bytes settling.
    const pastGen = pastSource ? anonCacheGeneration() : 0;
    const { rows, hasMore, totalPages } = await listPast(db, page, new Date(), q);
    c.header("cache-control", input.searching ? "private, no-store" : "public, max-age=300");
    // Browsing renders are public and shared, like the Kit twin: name the
    // Cookie variance so shared caches key anonymous and signed-in shells
    // apart. Searching renders stay private no-store with no Vary.
    if (!input.searching) c.header("vary", "Cookie");
    const pastResponse = await c.html(
      <PastEventsPage
        rows={rows}
        page={page}
        hasMore={hasMore}
        totalPages={totalPages}
        appUrl={c.env.APP_URL}
        q={q ?? ""}
      />,
    );
    // Buffer before the final generation comparison (see /events above): a
    // retire that lands while clone().text() is in flight must stop stale
    // archive bytes from settling; the compare-and-write stays synchronous.
    if (pastSource && pastKey && pastResponse.status === 200 && rows.length > 0) {
      const body = await pastResponse.clone().text();
      if (anonCacheGeneration() === pastGen) {
        writeAnonCache(
          pastKey,
          pastSource,
          {
            status: 200,
            cacheControl: pastResponse.headers.get("cache-control") ?? "public, max-age=300",
            vary: pastResponse.headers.get("vary"),
            body,
          },
          ANON_PAST_TTL_MS,
        );
      }
    }
    return pastResponse;
  });
}
