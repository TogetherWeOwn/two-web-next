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

  // Page lifetime: registrations and in-flight reads are aborted on pagehide
  // so they never resolve into a discarded document. A page restored from the
  // back-forward cache does not re-run this island, so register() below runs
  // again on a persisted pageshow with fresh controllers.
  // Per-call bounds (C3): every tool invocation owns a finite deadline
  // covering fetch plus body consumption, a bounded body mirroring
  // API_PUBLIC_BOUNDS.maxBodyBytes (src/public-data/contracts.ts), and
  // cleanup that settles even when abort is ignored. Failures reject with an
  // Error carrying a stable .code, a safe .message naming the next step, and
  // .retryAfter seconds for rate limits only; late completions are fenced and
  // pagehide settles in-flight reads instead of stranding them. Settlement
  // aborts the per-call controller and releases the queued entry plus its
  // page-signal forwarder, so settled calls hold no connections or listeners.
  // Bodies stream through the reader when one exists and fail as soon as the
  // byte count passes the cap; without a reader the buffered text is measured
  // in UTF-8 bytes. A 404 reads as not_found with no retry hint; other
  // unknown statuses read as unavailable and name try-again.
  var READ_DEADLINE_MS = 10000;
  var MAX_BODY_BYTES = 32768;
  var MAX_RETRY_AFTER_S = 86400;
  // Partial harnesses get pre-deadline behavior (mirrors the canTimeout guard
  // in going-count.js): without timers there is no owned deadline, and
  // without TextEncoder the cap falls back to string length. A missing or
  // broken AbortController degrades through the construction try/catch below
  // instead. Real browsers provide all three.
  var canTimeout = typeof setTimeout === "function" && typeof clearTimeout === "function";
  var canEncode = typeof TextEncoder !== "undefined";
  var pendingReads = [];
  var pageFetches = null;
  var registrations = [];

  function toolError(code, message, retryAfter) {
    var err = new Error(message);
    err.code = code;
    if (retryAfter) err.retryAfter = retryAfter;
    return err;
  }

  // Bounded Retry-After guidance: whole seconds, 1s..24h. Malformed values
  // yield undefined and absurd values cap at 24h; never reflects raw text.
  function retryAfterSeconds(res) {
    var headers = res && res.headers;
    var raw = headers && headers.get && headers.get("retry-after");
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    var seconds = Math.floor(+raw);
    if (Number.isNaN(seconds)) return undefined;
    return seconds < 1 ? 1 : seconds > MAX_RETRY_AFTER_S ? MAX_RETRY_AFTER_S : seconds;
  }

  function readJson(url) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = 0;
      var ctrl = null;
      var release = null;
      function settle(ok, value) {
        if (settled) return;
        settled = true;
        if (canTimeout) clearTimeout(timer);
        if (ctrl) {
          try {
            ctrl.abort();
          } catch (_settleAbortIgnored) {
            // Cleanup must not throw; the fence drops what follows.
          }
        }
        if (release) release();
        if (ok) resolve(value);
        else reject(value);
      }
      function fail(code, retryAfter) {
        settle(false, toolError(code, "Read failed (" + code + "); try again.", retryAfter));
      }
      function failGone() {
        fail("unavailable");
      }
      function failBad() {
        fail("invalid_response");
      }
      function failMissing() {
        settle(false, toolError("not_found", "No published event with that key."));
      }
      // Cap enforcement while streaming: count wire bytes as chunks arrive and
      // fail as soon as the cap passes, cancelling the reader so a fast large
      // body stops downloading. Without a reader the buffered text path below
      // measures UTF-8 bytes instead.
      function consumeCapped(res, done) {
        var body = res.body;
        var canStream =
          body && typeof body.getReader === "function" && typeof TextDecoder !== "undefined";
        if (!canStream) {
          res.text().then(done, failGone);
          return;
        }
        var reader = null;
        try {
          reader = body.getReader();
        } catch (_readerIgnored) {
          res.text().then(done, failGone);
          return;
        }
        var decoder = new TextDecoder();
        var text = "";
        var total = 0;
        function cancelReader() {
          try {
            reader.cancel();
          } catch (_cancelIgnored) {
            // Best-effort: abort below already stopped the fetch.
          }
        }
        function pump() {
          if (settled) {
            cancelReader();
            return;
          }
          reader.read().then(function (step) {
            if (settled) {
              cancelReader();
              return;
            }
            if (!step || step.done) {
              try {
                done(text + decoder.decode());
              } catch (_flushIgnored) {
                failBad();
              }
              return;
            }
            var chunk = step.value;
            total += chunk && chunk.byteLength ? chunk.byteLength : 0;
            if (total > MAX_BODY_BYTES) {
              cancelReader();
              failBad();
              return;
            }
            try {
              text += decoder.decode(chunk, { stream: true });
            } catch (_decodeIgnored) {
              cancelReader();
              failBad();
              return;
            }
            pump();
          }, failGone);
        }
        pump();
      }
      if (canTimeout) {
        timer = setTimeout(function () {
          fail("timeout");
        }, READ_DEADLINE_MS);
      }
      try {
        ctrl = new AbortController();
      } catch (_readAbortConstructIgnored) {
        // ctrl stays null; the read still issues and the deadline guards it.
      }
      // The forwarder is named so settle can remove it: settled calls release
      // their queue entry and listener instead of waiting for pagehide.
      function forwardAbort() {
        try {
          ctrl.abort();
        } catch (_forwardAbortIgnored) {
          // Already aborted; the settled fence drops what follows.
        }
      }
      var pageSignal = ctrl && pageFetches ? pageFetches.signal : null;
      pendingReads.push(failGone);
      if (pageSignal) pageSignal.addEventListener("abort", forwardAbort);
      release = function () {
        var at = pendingReads.indexOf(failGone);
        if (at >= 0) pendingReads.splice(at, 1);
        if (pageSignal) {
          try {
            pageSignal.removeEventListener("abort", forwardAbort);
          } catch (_releaseAbortIgnored) {
            // Listener removal is best-effort.
          }
        }
      };
      var init = { headers: { accept: "application/json" }, redirect: "manual" };
      if (ctrl) init.signal = ctrl.signal;
      fetch(url, init).then(function (res) {
        if (res && res.type === "opaqueredirect") {
          failBad();
          return;
        }
        if (!res || !res.ok) {
          var status = (res && res.status) || 0;
          if (status === 429) fail("rate_limited", retryAfterSeconds(res));
          else if (status === 404) failMissing();
          else failGone();
          return;
        }
        consumeCapped(res, function (text) {
          var bytes = canEncode ? new TextEncoder().encode(text).length : text.length;
          if (bytes > MAX_BODY_BYTES) {
            failBad();
            return;
          }
          try {
            settle(true, JSON.parse(text));
          } catch {
            failBad();
          }
        });
      }, failGone);
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
    if (!EVENT_KEY.test(key)) throw toolError("invalid_request", "That event key is not valid.");
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
        "List published Together We Own community events, earliest first (includes past events); use page/per_page to walk forward. Read-only; at most 20 rows per call.",
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

  function register() {
    pageFetches = typeof AbortController !== "undefined" ? new AbortController() : null;
    registrations = [];
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
  }

  register();

  function teardown() {
    for (var j = 0; j < registrations.length; j++) {
      try {
        registrations[j].abort();
      } catch {
        // Aborting twice is harmless; never break navigation cleanup.
      }
    }
    // Settle in-flight reads even when their fetch ignores abort: the page is
    // going away, so every pending call fails closed with a stable code while
    // the settled fence drops whatever the stranded fetch does next.
    while (pendingReads.length) pendingReads.pop()();
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
    // No once: leaving again after a back-forward-cache restore must tear
    // down the re-registered tools too. Teardown stays idempotent.
    scope.addEventListener("pagehide", teardown);
    scope.addEventListener("pageshow", function (event) {
      if (event && event.persisted) register();
    });
  }
})();
