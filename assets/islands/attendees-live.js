// Attendees-live island binder.
//
// Progressive enhancement over the SSR who's-going roster in
// `src/events/pages-detail.tsx`: listens for the `going-count-updated`
// CustomEvent broadcast by the rsvp-button island after every successful
// write, then re-reads the event page HTML (GET /e/<key>, text/html) and
// swaps the `[data-testid="event-attendees"]` section in place (no full
// reload). The SSR section and its full-page Refresh link stay as the
// no-JS fallback; this binder only patches nodes in place, never invents
// markup beyond the bounded stale/retry signal.
//
// Budget: one GET per answered event for this page's own key; non-matching
// keys fire nothing. No polling. One automatic retry, then a visible
// stale/retry signal (outside the RSVP island) instead of a silent
// contradiction with the count badge. A newer broadcast for the same page
// aborts the older read; its late completion patches nothing.

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

  function pageEventKey() {
    var mount =
      document.querySelector('[data-island="rsvp-button"]') ||
      document.querySelector('[data-island="going-count"]');
    var key = mount && mount.getAttribute("data-event-key");
    if (key) return key;
    try {
      var path = (typeof location !== "undefined" && (location.pathname || location.href)) || "";
      var match = /\/e\/([^/?#]+)/.exec(path);
      if (match) return decodeURIComponent(match[1]);
    } catch {}
    return null;
  }

  function findSection(doc) {
    try {
      return (doc || document).querySelector(SECTION);
    } catch {
      return null;
    }
  }

  function clearStale() {
    var stale = null;
    try {
      stale = document.querySelector('[data-testid="' + STALE_TESTID + '"]');
    } catch {
      stale = null;
    }
    if (!stale) return;
    try {
      if (stale.parentNode) stale.parentNode.removeChild(stale);
      else if (stale.remove) stale.remove();
    } catch {}
  }

  function showStale(key) {
    try {
      if (document.querySelector('[data-testid="' + STALE_TESTID + '"]')) return;
    } catch {}
    var note = null;
    try {
      note = document.createElement("p");
    } catch {
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
    } catch {
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
      else if (document.body) document.body.appendChild(note);
      else if (document.documentElement) document.documentElement.appendChild(note);
    } catch {}
  }

  // Swap the roster section from a re-rendered event page. Returns true when
  // the DOM now matches the server truth (including both-missing as no-op).
  function swapFromHtml(html) {
    var parsed = null;
    try {
      parsed = new DOMParser().parseFromString(html, "text/html");
    } catch {
      return false;
    }
    if (!parsed || !parsed.querySelector) return false;
    var fresh = findSection(parsed);
    var old = findSection();
    if (fresh && old) {
      // Replace the node so attributes (counts in the heading, list order)
      // match the server exactly. The holder bridges documents without
      // importNode, which minimal harnesses may not provide.
      try {
        var holder = document.createElement("div");
        holder.innerHTML = fresh.outerHTML;
        var node = holder.querySelector(SECTION);
        if (node && old.parentNode) {
          old.parentNode.replaceChild(node, old);
          return true;
        }
      } catch {}
      try {
        old.innerHTML = fresh.innerHTML;
        return true;
      } catch {
        return false;
      }
    }
    if (fresh && !old) {
      try {
        var holder2 = document.createElement("div");
        holder2.innerHTML = fresh.outerHTML;
        var node2 = holder2.querySelector(SECTION);
        if (!node2) return false;
        var anchor = null;
        try {
          anchor = document.querySelector(".event-discovery");
        } catch {
          anchor = null;
        }
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node2, anchor);
        else if (document.body) document.body.appendChild(node2);
        else return false;
        return true;
      } catch {
        return false;
      }
    }
    if (!fresh && old) {
      // The server renders no section for an empty roster.
      try {
        if (old.parentNode) old.parentNode.removeChild(old);
        else if (old.remove) old.remove();
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  function clearStateTimeout(state) {
    if (state.timeout !== null && state.timeout !== undefined) {
      try {
        clearTimeout(state.timeout);
      } catch {}
      state.timeout = null;
    }
  }

  function onFailure(state) {
    if (current !== state) return;
    clearStateTimeout(state);
    if (state.attempt < MAX_ATTEMPTS) {
      state.attempt += 1;
      if (!canTimeout) {
        // Without timers there is no deferred retry: surface the signal now
        // rather than leaving a silent contradiction.
        current = null;
        showStale(state.key);
        return;
      }
      state.retryTimer = setTimeout(function () {
        if (current !== state) return;
        state.retryTimer = null;
        attempt(state);
      }, RETRY_DELAY_MS);
    } else {
      current = null;
      showStale(state.key);
    }
  }

  function attempt(state) {
    var controller = canAbort ? new AbortController() : null;
    state.controller = controller;
    if (canTimeout) {
      state.timeout = setTimeout(function () {
        if (current !== state) return;
        // Abort first so a real transport rejects into the failure path;
        // harnesses without abort support still get the bounded retry via
        // the direct failure below only when no controller exists.
        if (controller) {
          try {
            controller.abort();
          } catch {}
        } else {
          onFailure(state);
        }
      }, READ_DEADLINE_MS);
    }
    var options = {
      method: "GET",
      headers: { accept: "text/html" },
      credentials: "same-origin",
    };
    if (controller) options.signal = controller.signal;
    fetch("/e/" + encodeURIComponent(state.key), options).then(
      function (res) {
        if (current !== state) return;
        clearStateTimeout(state);
        if (!res || !res.ok) {
          onFailure(state);
          return;
        }
        var text = null;
        try {
          text = res.text();
        } catch {
          onFailure(state);
          return;
        }
        if (!text || typeof text.then !== "function") {
          onFailure(state);
          return;
        }
        text.then(
          function (html) {
            if (current !== state) return;
            var ok = false;
            try {
              ok = swapFromHtml(html);
            } catch {
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
            if (current !== state) return;
            onFailure(state);
          },
        );
      },
      function () {
        if (current !== state) return;
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
      if (current.retryTimer) {
        try {
          clearTimeout(current.retryTimer);
        } catch {}
      }
      clearStateTimeout(current);
      if (current.controller) {
        try {
          current.controller.abort();
        } catch {}
      }
    }
    var state = { key: key, attempt: 1, controller: null, timeout: null, retryTimer: null };
    current = state;
    attempt(state);
  }

  document.addEventListener(UPDATED, function (ev) {
    var detail = (ev && ev.detail) || {};
    if (!detail.eventKey) return;
    refresh(detail.eventKey);
  });
})();
