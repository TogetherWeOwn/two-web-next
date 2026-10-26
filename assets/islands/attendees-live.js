// Attendees-live island binder.
//
// Progressive enhancement over the SSR who's-going roster in
// `src/events/pages-detail.tsx`: listens for the `going-count-updated`
// CustomEvent broadcast by the rsvp-button island after every successful
// write, then re-reads the event page HTML (GET /e/<key>, text/html, with
// the x-two-island fragment header so the server answers without rotating
// the single-use session bearer) and swaps the
// `[data-testid="event-attendees"]` section in place (no full reload). The
// SSR section and its full-page Refresh link stay as the
// no-JS fallback; this binder only patches nodes in place, never invents
// markup beyond the bounded stale/retry signal.
//
// Budget: one GET per answered event for this page's own key; non-matching
// keys fire nothing. No polling. One automatic retry, then a visible
// stale/retry signal (outside the RSVP island) instead of a silent
// contradiction with the count badge. A newer broadcast for the same page
// aborts the older read; its late completion patches nothing. The refresh
// preserves the displayed attendee page (?attendees=N) so a later page never
// snaps back to page one.

(function () {
  var SECTION = '[data-testid="event-attendees"]';
  var STALE_TESTID = "event-attendees-stale";
  var RETRY_TESTID = "event-attendees-retry";
  var UPDATED = "going-count-updated";
  // Owned read deadline: fetch headers plus the HTML body, at most ~5s
  // (mirrors GOING_COUNT_READ_DEADLINE_MS). On expiry the owned fetch aborts
  // and the failure path below runs (one retry, then the stale signal).
  // A newer broadcast aborts the older read; its late completion patches
  // nothing.
  var READ_DEADLINE_MS = 5000;
  var RETRY_DELAY_MS = 1000;
  var MAX_ATTEMPTS = 2;
  var current = null;
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";
  var canAbort = typeof AbortController !== "undefined";

  // A second evaluation of this script must not stack a second document
  // listener: the guard lives on the shared DOM, not in this closure.
  var root = document.documentElement;
  if (root) {
    if (root.getAttribute("data-attendees-live-ready") === "1") return;
    root.setAttribute("data-attendees-live-ready", "1");
  }

  function query(selector) {
    return document.querySelector(selector);
  }

  function pageEventKey() {
    var mount = query('[data-island="rsvp-button"]') || query('[data-island="going-count"]');
    var key = mount && mount.getAttribute("data-event-key");
    if (key) return key;
    try {
      var path = (typeof location !== "undefined" && (location.pathname || location.href)) || "";
      var match = /\/e\/([^/?#]+)/.exec(path);
      if (match) return decodeURIComponent(match[1]);
    } catch (_locationUnreadable) {
      // Fall through to null: without a page key the refresh stays idle and
      // the SSR roster plus Refresh link remain the fallback.
    }
    return null;
  }

  // Attendee parsing mirrors parseAttendeePageParam: only full positive
  // integers with exact offset arithmetic; malformed values stay on page one.
  // Forward bounded scalar archive state on this read only (255 code points,
  // like MAX_QUERY_LENGTH). The server remains the archive admission authority.
  var ATTENDEE_PAGE_SIZE = 100;
  function rosterQuery() {
    var result = new URLSearchParams();
    try {
      var search = typeof location !== "undefined" ? location.search || "" : "";
      var params = new URLSearchParams(search);
      var raw = params.get("attendees");
      var page = Number(raw);
      if (
        /^[1-9]\d*$/.test(raw || "") &&
        Number.isSafeInteger(page) &&
        Number.isSafeInteger((page - 1) * ATTENDEE_PAGE_SIZE) &&
        page > 1
      )
        result.set("attendees", raw);
      // Never repair malformed Unicode or collapse duplicate browse fields.
      // Reuse the scalar envelope for each origin; the server re-admits it.
      decodeURIComponent(search);
      ["archive", "schedule"].forEach(function (prefix) {
        var fields = (
          prefix === "archive" ? "Page Query" : "Page Query Game Past View Month"
        ).split(" ");
        if (
          (prefix === "archive" || search.length <= 4096) &&
          params.getAll(prefix + "Page").length === 1 &&
          fields.every(function (field) {
            var values = params.getAll(prefix + field);
            return (
              values.length <= 1 &&
              Array.from(values[0] || "").length <= (field === "Page" ? 16 : 255)
            );
          })
        )
          fields.forEach(function (field) {
            var name = prefix + field;
            if (params.has(name)) result.set(name, params.get(name));
          });
      });
    } catch (_searchUnreadable) {
      // Keep the independently parsed attendee page; absent archive context
      // returns to All events rather than inventing another search.
    }
    var query = result.toString();
    return query ? "?" + query : "";
  }

  function findSection(doc) {
    var scope = doc || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.querySelector !== "function") return null;
    return scope.querySelector(SECTION);
  }

  function clearStale() {
    var stale = null;
    try {
      stale = query('[data-testid="' + STALE_TESTID + '"]');
    } catch (_staleLookupIgnored) {
      // Fall through with stale null: no signal to clear, the refresh still
      // completes and the next failure re-renders the signal.
      stale = null;
    }
    if (!stale) return;
    var refocus = focusedInside(stale);
    try {
      if (stale.parentNode) stale.parentNode.removeChild(stale);
      else if (stale.remove) stale.remove();
      if (refocus) {
        // Empty-to-empty recovery has no roster heading to receive focus.
        // <main> is already focusable; never steal focus that moved away.
        var fallback = query("main");
        if (fallback && typeof fallback.focus === "function") fallback.focus();
      }
    } catch (_staleRemoveIgnored) {
      // Fall through: a leftover stale note is corrected on the next refresh
      // via showStale's already-present guard, never a silent contradiction.
    }
  }

  function showStale(key) {
    try {
      if (query('[data-testid="' + STALE_TESTID + '"]')) return;
    } catch (_guardLookupIgnored) {
      // Fall through and render: a duplicate signal is harmless, a missing
      // one would be the silent contradiction this island must not leave.
    }
    var note = null;
    try {
      note = document.createElement("p");
    } catch (_createIgnored) {
      return;
    }
    note.setAttribute("role", "status");
    note.setAttribute("data-testid", STALE_TESTID);
    // Direct text carries the stale copy so behavior-level readers match it
    // without depending on the retry control's label; the testid marker is
    // the second signal.
    note.textContent = "Attendees could not refresh. ";
    var retry = null;
    try {
      retry = document.createElement("button");
    } catch (_retryCreateIgnored) {
      // Fall through with retry null: the stale note still renders, only the
      // manual retry control is missing, and the next broadcast retries.
      retry = null;
    }
    if (retry) {
      retry.setAttribute("type", "button");
      retry.setAttribute("data-testid", RETRY_TESTID);
      retry.textContent = "Try again";
      retry.addEventListener("click", function () {
        refresh(key);
      });
      note.appendChild(retry);
    }
    var host = findSection();
    try {
      if (host) host.appendChild(note);
      else mountWhereRosterLives(note);
    } catch (_signalMountIgnored) {
      // Fall through: without a mount point the signal is dropped, but the
      // count badge already updated so the next broadcast re-attempts.
    }
  }

  // Mount a node where the roster section lives: inside the existing
  // section when present, otherwise slotted before the discovery content
  // (inside <main>) so a first-RSVP stale signal never lands after the site
  // footer. Falls back to <main>, then body, when the anchor is missing.
  function mountWhereRosterLives(node) {
    var anchor = null;
    try {
      anchor = query(".event-discovery");
    } catch (_anchorLookupIgnored) {
      // Fall through with anchor null: the main/body fallbacks below apply.
      anchor = null;
    }
    try {
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(node, anchor);
        return true;
      }
    } catch (_anchorInsertIgnored) {
      // Fall through to the main/body fallbacks below.
    }
    var main = null;
    try {
      main = query("main");
    } catch (_mainLookupIgnored) {
      main = null;
    }
    try {
      if (main) {
        main.appendChild(node);
        return true;
      }
    } catch (_mainInsertIgnored) {
      // Fall through to the body fallbacks below.
    }
    try {
      if (document.body) {
        document.body.appendChild(node);
        return true;
      }
    } catch (_bodyInsertIgnored) {
      // Fall through to false: without a mount point the caller reports
      // failure and runs the bounded retry/stale path.
    }
    return false;
  }

  // Move keyboard focus into the freshly swapped section when the swap
  // removed the focused element (e.g. the "Try again" button lived inside
  // the old section). Without this the focus drops to BODY and assistive
  // tech loses its place.
  function restoreFocusAfterSwap(section) {
    var heading = null;
    try {
      heading = section.querySelector("#event-attendees-heading");
    } catch (_headingLookupIgnored) {
      heading = null;
    }
    var target = heading || section;
    try {
      if (target && typeof target.setAttribute === "function") {
        target.setAttribute("tabindex", "-1");
      }
    } catch (_tabindexIgnored) {
      // Fall through to the focus attempt: the target is still focusable
      // enough in most hosts without the tabindex hint.
    }
    try {
      if (target && typeof target.focus === "function") target.focus();
    } catch (_focusIgnored) {
      // Fall through: the roster still matches the server truth; only the
      // focus restoration is skipped.
    }
  }

  function focusedInside(node) {
    try {
      if (!node || typeof node.contains !== "function") return false;
      var active = document.activeElement;
      if (!active) return false;
      return node.contains(active);
    } catch (_focusLookupIgnored) {
      // Fall through to false: without a readable focus state the refresh
      // completes without moving focus.
      return false;
    }
  }
  // Prefers an explicit cross-document import when the host provides it
  // (same contract as the events-calendar island); otherwise moves the node
  // directly, which the DOM auto-adopts on insert. Either way no markup
  // string is re-serialized into the live tree.
  function adopt(node) {
    try {
      if (typeof document.importNode === "function") {
        var imported = document.importNode(node, true);
        if (imported) return imported;
      }
    } catch (_importIgnored) {
      // Fall through to the direct move below.
    }
    return node;
  }

  // Swap the roster section from a re-rendered event page. Returns true when
  // the DOM now matches the server truth (including both-missing as no-op).
  // Admits only the authoritative document for the requested event: the
  // parsed page must carry this event's mount key. Anything else (an
  // unrelated/error document, or another event's page) returns false so the
  // caller runs the bounded retry/stale path and the last-good roster stays.
  function swapFromHtml(html, key) {
    var parsed = null;
    try {
      parsed = new DOMParser().parseFromString(html, "text/html");
    } catch (_parseIgnored) {
      // Fall through to false: an unparseable body keeps the current roster
      // and runs the bounded retry/stale path instead of patching garbage.
      return false;
    }
    if (!parsed || !parsed.querySelector) return false;
    var admitted = false;
    try {
      var mounts = parsed.querySelectorAll("[data-event-key]");
      for (var i = 0; mounts && i < mounts.length; i++) {
        var mountKey = null;
        try {
          mountKey = mounts[i].getAttribute("data-event-key");
        } catch (_keyUnreadable) {
          mountKey = null;
        }
        if (mountKey === key) {
          admitted = true;
          break;
        }
      }
    } catch (_admissionIgnored) {
      admitted = false;
    }
    if (!admitted) return false;
    var fresh = findSection(parsed);
    var old = findSection();
    if (fresh && old) {
      // Replace the node so attributes (counts in the heading, list order)
      // match the server exactly; the insert adopts across documents.
      var refocus = focusedInside(old);
      try {
        if (!old.parentNode) return false;
        var adopted = adopt(fresh);
        old.parentNode.replaceChild(adopted, old);
        if (refocus) restoreFocusAfterSwap(adopted);
        return true;
      } catch (_replaceIgnored) {
        // Fall through to false: the roster keeps server page-load truth and
        // the caller runs the bounded retry/stale path.
        return false;
      }
    }
    if (fresh && !old) {
      var staleForFocus = null;
      try {
        staleForFocus = query('[data-testid="' + STALE_TESTID + '"]');
      } catch (_staleFocusLookupIgnored) {
        staleForFocus = null;
      }
      var refocusAfterInsert = focusedInside(staleForFocus);
      try {
        var node2 = adopt(fresh);
        if (!mountWhereRosterLives(node2)) return false;
        if (refocusAfterInsert) restoreFocusAfterSwap(node2);
        return true;
      } catch {
        return false;
      }
    }
    if (!fresh && old) {
      // The server renders no section for an empty roster.
      var refocusAfterPrune = focusedInside(old);
      try {
        if (old.parentNode) old.parentNode.removeChild(old);
        else if (old.remove) old.remove();
        else return false;
        if (refocusAfterPrune) {
          // <main id="main" tabindex="-1"> in EventDetailShell is already
          // focusable, so no tabindex hint is needed here.
          try {
            var fallback = query("main");
            if (fallback && typeof fallback.focus === "function") fallback.focus();
          } catch (_fallbackFocusIgnored) {
            // Fall through: the roster still matches the server truth; only
            // the focus restoration is skipped.
          }
        }
        return true;
      } catch (_pruneIgnored) {
        // Fall through to false: the stale section stays and the caller runs
        // the bounded retry/stale path rather than claiming success.
        return false;
      }
    }
    return true;
  }

  function clearStateTimeout(state) {
    if (state.tmr != null) {
      try {
        clearTimeout(state.tmr);
      } catch (_clearIgnored) {
        // Fall through: the handle is dropped below either way, so at most
        // one late timer fires and its state guard no-ops it.
      }
      state.tmr = null;
    }
  }

  function onFailure(state) {
    if (current !== state) return;
    clearStateTimeout(state);
    if (state.seq < MAX_ATTEMPTS) {
      state.seq += 1;
      if (!canTimeout) {
        // Without timers there is no deferred retry: surface the signal now
        // rather than leaving a silent contradiction.
        current = null;
        showStale(state.key);
        return;
      }
      state.retry = setTimeout(function () {
        if (current !== state) return;
        state.retry = null;
        attempt(state);
      }, RETRY_DELAY_MS);
    } else {
      current = null;
      showStale(state.key);
    }
  }

  function attempt(state) {
    // Per-attempt ownership: capture the sequence number this read belongs
    // to. onFailure increments state.seq exactly once for the winning
    // settlement, so every late header/body/rejection from an older attempt
    // sees a mismatch and returns before touching roster state, timers,
    // retries or stale feedback. No new state fields: the existing counter
    // doubles as the generation.
    // Budget: state fields use short names (seq/ctrl/tmr/retry) because the
    // minifier cannot shorten property names; see ci/bundle-budget.json.
    var ownedAttempt = state.seq;
    var controller = null;
    if (canAbort) {
      try {
        controller = new AbortController();
      } catch (_abortConstructIgnored) {
        // Fall through with controller still null: the read is still issued
        // and the deadline below still settles it, so a throwing host never
        // suppresses the refresh.
      }
    }
    state.ctrl = controller;
    if (canTimeout) {
      state.tmr = setTimeout(function () {
        if (current !== state || state.seq !== ownedAttempt) return;
        // Abort first so a real transport rejects into the failure path;
        // then settle here regardless: an abort-ignoring transport (or a
        // throwing abort) must not hang recovery past the deadline. The
        // later abort rejection re-enters onFailure with a stale attempt
        // number and is fenced there. Abort stays best effort.
        if (controller) {
          try {
            controller.abort();
          } catch (_deadlineAbortIgnored) {
            // Fall through to the owned failure below.
          }
        }
        onFailure(state);
      }, READ_DEADLINE_MS);
    }
    var options = {
      method: "GET",
      headers: {
        accept: "text/html",
        // Fragment read: the server answers without rotating the session, so
        // this re-read racing a reload (or a superseded attempt racing its
        // replacement) cannot burn the single-use bearer the page view holds.
        // Same x-two-island contract as the events-calendar fragment.
        "x-two-island": "attendees-live",
      },
      credentials: "same-origin",
    };
    if (controller) options.signal = controller.signal;
    fetch("/e/" + encodeURIComponent(state.key) + rosterQuery(), options).then(
      function (res) {
        // Fence stale attempts: only the attempt that owns the current
        // counter may settle. Late headers from a timed-out or superseded
        // attempt return here before touching roster state or timers.
        if (current !== state || state.seq !== ownedAttempt) return;
        // The deadline stays armed past the headers: it clears only once the
        // body is read (below) or fails (onFailure), so a stalled body still
        // retries instead of hanging silently.
        if (!res || !res.ok) {
          onFailure(state);
          return;
        }
        var text = null;
        try {
          text = res.text();
        } catch (_bodyReadIgnored) {
          // Fall through to the failure path: no body, no swap.
          onFailure(state);
          return;
        }
        if (!text || typeof text.then !== "function") {
          onFailure(state);
          return;
        }
        text.then(
          function (html) {
            // Late bodies from a timed-out or superseded attempt cannot
            // swap the roster, clear the newer deadline or clear stale
            // feedback: only the owning attempt settles.
            if (current !== state || state.seq !== ownedAttempt) return;
            clearStateTimeout(state);
            var ok = false;
            try {
              ok = swapFromHtml(html, state.key);
            } catch (_swapIgnored) {
              // Fall through with ok false: the roster is untouched and the
              // bounded retry/stale path runs.
              ok = false;
            }
            if (!ok) {
              onFailure(state);
              return;
            }
            clearStale();
            current = null;
          },
          function () {
            // A late rejection (including the abort rejection that follows
            // a deadline abort) must not clear the newer deadline, add a
            // retry or surface stale feedback: the winning settlement
            // already advanced state.seq, so the stale number fences it.
            if (current !== state || state.seq !== ownedAttempt) return;
            onFailure(state);
          },
        );
      },
      function () {
        if (current !== state || state.seq !== ownedAttempt) return;
        onFailure(state);
      },
    );
  }

  function refresh(key) {
    var pageKey = pageEventKey();
    if (!key) key = pageKey;
    if (!key) return;
    // Same-key badges share one response so they cannot disagree; a broadcast
    // for another event fires nothing here.
    if (pageKey && key !== pageKey) return;
    if (current) {
      if (current.retry) {
        try {
          clearTimeout(current.retry);
        } catch (_supersedeClearIgnored) {
          // Fall through: the superseded timer's state guard no-ops it even
          // if the clear throws.
        }
      }
      clearStateTimeout(current);
      if (current.ctrl) {
        try {
          current.ctrl.abort();
        } catch (_supersedeAbortIgnored) {
          // Fall through: the superseded read's state guard drops its late
          // completion even without abort support.
        }
      }
    }
    var state = { key: key, seq: 1, ctrl: null, tmr: null, retry: null };
    current = state;
    attempt(state);
  }

  document.addEventListener(UPDATED, function (ev) {
    var detail = (ev && ev.detail) || {};
    if (!detail.eventKey) return;
    refresh(detail.eventKey);
  });
})();
