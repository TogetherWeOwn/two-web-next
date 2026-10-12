// B1 read-only WebMCP pilot (flag-gated server-side): registers the four
// public read tools (T1–T4) on document.modelContext when the browser offers
// it. No polyfill: when the API is absent this file returns before any fetch
// and page behaviour is unchanged. Every tool reads the session-free,
// published-only /api/public/* surface, so the result is identical for
// anonymous viewers, cookie bearers and moderator sessions — no session state
// is ever read or sent as a parameter. Framework-free on purpose: the same
// file ports to the SvelteKit shell unchanged.
(() => {
  var doc = typeof document !== "undefined" ? document : null;
  var nav = typeof navigator !== "undefined" ? navigator : null;
  var context = null;
  try {
    context = (doc && doc.modelContext) || (nav && nav.modelContext) || null;
  } catch {
    return;
  }
  if (!context) return;
  var hasRegister = typeof context.registerTool === "function";
  var hasProvide = typeof context.provideContext === "function";
  if (!hasRegister && !hasProvide) return;

  // Page lifetime: aborted on navigation so in-flight tool reads never
  // resolve into a discarded document.
  var pageFetches = typeof AbortController !== "undefined" ? new AbortController() : null;
  var registrations = [];

  function readJson(url) {
    var init = { headers: { accept: "application/json" } };
    if (pageFetches) init.signal = pageFetches.signal;
    return fetch(url, init).then((res) => {
      if (!res.ok) throw new Error("Public read failed with status " + res.status + ".");
      return res.json();
    });
  }

  // Mirrors parsePublicEventId in src/public-data/contracts.ts: the stored
  // uppercase ULID, never the database row id. Junk keys fail closed here so
  // no request leaves the page.
  var EVENT_KEY = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

  function clampInt(value, fallback, min, max) {
    var n = typeof value === "number" ? Math.floor(value) : fallback;
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  // T1: paged published events. Bounds mirror the API caps (20 rows max).
  function searchEvents(input) {
    var args = input && typeof input === "object" ? input : {};
    var page = clampInt(args.page, 1, 1, 1000000);
    var perPage = clampInt(args.per_page, 20, 1, 20);
    return readJson("/api/public/events?page=" + page + "&per_page=" + perPage);
  }

  // T2: one published event by key.
  function getEvent(input) {
    var key = input && typeof input.event_key === "string" ? input.event_key : "";
    if (!EVENT_KEY.test(key)) throw new Error("That event key is not valid.");
    return readJson("/api/public/events/" + encodeURIComponent(key));
  }

  // T3: live community snapshot (unavailable collectors read as null).
  function getCommunity() {
    return readJson("/api/public/community");
  }

  // T4: join handoff (Discord invite plus intro; no member data).
  function getJoinInfo() {
    return readJson("/api/public/join");
  }

  var READ_ONLY = { readOnlyHint: true };
  var tools = [
    {
      name: "two_search_events",
      description:
        "Search published Together We Own community events, newest first. Read-only; paged, at most 20 rows per call.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1, default: 1 },
          per_page: { type: "integer", minimum: 1, maximum: 20, default: 20 },
        },
      },
      annotations: READ_ONLY,
      execute: searchEvents,
    },
    {
      name: "two_get_event",
      description:
        "Read one published event by its event key. Read-only; unpublished or unknown keys are not found.",
      inputSchema: {
        type: "object",
        properties: { event_key: { type: "string" } },
        required: ["event_key"],
      },
      annotations: READ_ONLY,
      execute: getEvent,
    },
    {
      name: "two_get_community",
      description:
        "Read the live community snapshot: member and online counts plus ranks. Read-only; unavailable counts are null, never zero.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ_ONLY,
      execute: getCommunity,
    },
    {
      name: "two_get_join_info",
      description:
        "Read how to join: the intro and the Discord invite link. Read-only; joining itself happens in Discord.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ_ONLY,
      execute: getJoinInfo,
    },
  ];

  if (hasRegister) {
    for (var i = 0; i < tools.length; i++) {
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (controller) registrations.push(controller);
      context.registerTool(tools[i], controller ? { signal: controller.signal } : undefined);
    }
  } else {
    // Legacy Chrome surface: one batch replacing the page toolset.
    context.provideContext({ tools: tools });
  }

  function teardown() {
    for (var j = 0; j < registrations.length; j++) {
      try {
        registrations[j].abort();
      } catch {
        // Aborting twice is harmless; never break navigation cleanup.
      }
    }
    if (pageFetches) {
      try {
        pageFetches.abort();
      } catch {
        // Same: cleanup must not throw.
      }
    }
    if (!hasRegister && typeof context.clearContext === "function") {
      try {
        context.clearContext();
      } catch {
        // Legacy cleanup is best-effort.
      }
    }
  }

  var scope = typeof window !== "undefined" ? window : doc;
  if (scope && typeof scope.addEventListener === "function") {
    scope.addEventListener("pagehide", teardown, { once: true });
  }
})();
