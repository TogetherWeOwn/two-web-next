// GoingCount island binder (board-9689, slice 1).
//
// Progressive enhancement over the SSR badge in `renderGoingCount`:
// listens for the `going-count-updated` CustomEvent broadcast by the
// rsvp-button island after every successful write, then re-reads the
// aggregate from GET /events.json and patches the count + announcement
// nodes in place (no full re-render).
//
// Budget: one GET per answered event; non-matching keys fire nothing.
// No polling. A failed refresh keeps the last known-good numbers but visibly
// qualifies them as stale (a polite note with last-saved context plus one
// explicit aggregate-only retry); the optimistic answer on the button island
// is the member-visible write confirmation, and a confirmed RSVP state is
// never retracted by a later read failure.

(function () {
  var MOUNT = '[data-island="going-count"]';
  var EVENT = "going-count-updated";
  var REFRESHED = "going-count-refreshed";
  var URL = "/events.json";
  // Owned read deadline: fetch headers plus the JSON body, at most ~5s
  // (mirrors GOING_COUNT_READ_DEADLINE_MS in
  // src/islands/contracts-going-count.ts). On expiry the owned fetch aborts
  // and the last-known-good numbers stay, qualified as stale. A newer
  // broadcast for the same key aborts the older read; its late completion
  // patches nothing.
  var READ_DEADLINE_MS = 5000;
  // Stale/retry vocabulary (mirrors GOING_COUNT_STALE_TESTID /
  // GOING_COUNT_RETRY_TESTID in src/islands/contracts-going-count.ts and the
  // attendees-live stale/retry precedent).
  var STALE_TESTID = "event-going-count-stale";
  var RETRY_TESTID = "event-going-count-retry";
  // Leading space: the note mounts inline after the count line, so it must
  // not run against the retained numbers.
  var STALE_COPY = " Going count could not refresh. Showing the last saved count. ";
  var latest = new Map();
  var inflight = new Map();
  // Harnesses with a partial fake clock (setTimeout only) get the
  // pre-deadline behavior. AbortController is universal in browsers; a
  // harness without it still gets ownership supersede, only the network
  // abort is skipped.
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";
  var canAbort = typeof AbortController !== "undefined";

  // A second evaluation of this script must not stack a second document
  // listener: the guard lives on the shared DOM, not in this closure.
  var root = document.documentElement;
  if (root) {
    if (root.getAttribute("data-going-count-ready") === "1") return;
    root.setAttribute("data-going-count-ready", "1");
  }

  function announcementText(state) {
    switch (state) {
      case "going":
        return "You're going.";
      case "waitlisted":
        return "You're on the waitlist.";
      case "none":
        return "RSVP removed.";
      default:
        return "";
    }
  }

  function countText(going, capacity) {
    return capacity !== null && capacity !== undefined && capacity !== ""
      ? going + " of " + capacity + " going"
      : going + " going";
  }

  function capacityFor(row, node) {
    var capacity;
    if (Object.prototype.hasOwnProperty.call(row, "capacity")) {
      // Explicit null is authoritative: the event is now unbounded.
      capacity = row.capacity;
    } else {
      // Legacy aggregate fixtures omit capacity; only a known SSR value
      // can fill that gap. Missing/malformed attributes are not unbounded.
      var raw = node.getAttribute("data-capacity");
      if (raw === null || (raw !== "" && !/^\d+$/.test(raw))) return;
      capacity = raw === "" ? null : Number(raw);
    }
    if (capacity === null || (Number.isSafeInteger(capacity) && capacity > 0)) return capacity;
  }

  function spotsLeftText(going, capacity) {
    var left = Math.max(0, capacity - going);
    return left <= 0 ? "Full" : left + " of " + capacity + " spots left";
  }

  // Release a settled read without touching a newer owner's entry. The
  // deadline additionally invalidates ownership so a hung body that resolves
  // late patches nothing.
  function releaseRead(key, request) {
    var current = inflight.get(key);
    if (current && current.request === request) {
      if (current.timeout !== null) clearTimeout(current.timeout);
      inflight.delete(key);
    }
  }

  function nodesForKey(key) {
    var nodes = [];
    try {
      document.querySelectorAll(MOUNT).forEach(function (node) {
        if (node.getAttribute("data-event-key") === key) nodes.push(node);
      });
    } catch (_nodesLookupIgnored) {
      // Fall through with the badges matched so far; the caller no-ops on
      // an empty set instead of issuing a read it cannot patch.
    }
    return nodes;
  }

  function focusedInside(node) {
    try {
      if (!node || typeof node.contains !== "function") return false;
      var active = document.activeElement;
      if (!active) return false;
      return node.contains(active);
    } catch (_focusLookupIgnored) {
      // Fall through to false: without a readable focus state the refresh
      // must not move focus anywhere.
      return false;
    }
  }

  function clearStale() {
    var stale = null;
    try {
      stale = document.querySelector('[data-testid="' + STALE_TESTID + '"]');
    } catch (_staleLookupIgnored) {
      // Fall through with stale null: no signal to clear, the refresh still
      // completes and the next failure re-renders the signal.
      stale = null;
    }
    if (!stale) return;
    var refocus = focusedInside(stale);
    try {
      if (stale.parentNode) stale.parentNode.removeChild(stale);
      else if (typeof stale.remove === "function") stale.remove();
      if (refocus) {
        // Recovery removed the focused retry: <main> is already focusable;
        // never steal focus that moved away while the read was pending.
        var fallback = document.querySelector("main");
        if (fallback && typeof fallback.focus === "function") fallback.focus();
      }
    } catch (_staleRemoveIgnored) {
      // Fall through: a leftover stale note is corrected on the next refresh
      // via showStale's already-present guard, never a silent contradiction.
    }
  }

  function showStale(key, nodes) {
    try {
      if (document.querySelector('[data-testid="' + STALE_TESTID + '"]')) return;
    } catch (_guardLookupIgnored) {
      // Fall through and render: a duplicate signal is harmless, a missing
      // one would be the silent contradiction this island must not leave.
    }
    var note = null;
    try {
      note = document.createElement("span");
    } catch (_createIgnored) {
      return;
    }
    note.setAttribute("role", "status");
    note.setAttribute("data-testid", STALE_TESTID);
    // Direct text carries the stale copy so behavior-level readers match it
    // without depending on the retry control's label; the testid marker is
    // the second signal.
    note.textContent = STALE_COPY;
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
        // Aggregate-only retry: the same keyed GET, never an RSVP write, and
        // no viewer state to replay. Nodes re-resolve at click time so a
        // re-rendered badge still shares the one read.
        var current = nodesForKey(key);
        if (current.length) refresh(current, key);
      });
      try {
        note.appendChild(retry);
      } catch (_retryMountIgnored) {
        // Fall through: the note still qualifies the retained numbers.
      }
    }
    var host = nodes && nodes[0];
    try {
      if (host && typeof host.appendChild === "function") host.appendChild(note);
    } catch (_signalMountIgnored) {
      // Fall through: without a mount point the signal is dropped, but the
      // next broadcast or retry re-attempts the read.
    }
  }

  function refresh(nodes, key, state) {
    // A new broadcast owns both the read and its announcement, even if it
    // fails. An older completion must never replace the last good state.
    // A newer broadcast for the same key aborts the older fetch outright.
    var prev = inflight.get(key);
    if (prev) {
      if (prev.timeout !== null) clearTimeout(prev.timeout);
      if (prev.controller) {
        try {
          prev.controller.abort();
        } catch {}
      }
    }
    var request = {};
    latest.set(key, request);
    // Best effort: a host whose AbortController construction throws must not
    // suppress the count read (or, on the shared broadcast chain, a later
    // island's read). Without a controller the deadline below still guards
    // the fetch and the late completion is fenced by the inflight check.
    var controller = null;
    if (canAbort) {
      try {
        controller = new AbortController();
      } catch (_countAbortConstructIgnored) {
        // controller stays null; the read still issues (see above).
      }
    }
    var timeout = null;
    if (canTimeout) {
      timeout = setTimeout(function () {
        var current = inflight.get(key);
        if (!current || current.request !== request) return;
        releaseRead(key, request);
        if (latest.get(key) === request) latest.delete(key);
        if (controller) {
          try {
            controller.abort();
          } catch {}
        }
        showStale(key, nodes);
      }, READ_DEADLINE_MS);
    }
    inflight.set(key, { request: request, controller: controller, timeout: timeout });
    fetch(URL + "?event_key=" + encodeURIComponent(key), {
      headers: { accept: "application/json" },
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("events " + res.status);
        return res.json();
      })
      .then(function (rows) {
        try {
          if (latest.get(key) !== request) return;
          var list = Array.isArray(rows) ? rows : rows && rows.data;
          if (!Array.isArray(list)) {
            showStale(key, nodes);
            return;
          }
          var row = list.find(function (r) {
            return r && typeof r === "object" && !Array.isArray(r) && r.event_key === key;
          });
          if (!row || !Number.isSafeInteger(row.going_count) || row.going_count < 0) {
            showStale(key, nodes);
            return;
          }
          // Seat occupancy drives spots/full; absent on older snapshots, where
          // the attributable count is the only seat signal. A malformed
          // occupancy rejects the row like a malformed count.
          var occupancy = row.going_occupancy === undefined ? row.going_count : row.going_occupancy;
          if (!Number.isSafeInteger(occupancy) || occupancy < 0) {
            showStale(key, nodes);
            return;
          }
          // The keyed snapshot carries the current cap (`eventJson`); a
          // moderator capacity edit between SSR and refresh must move both
          // displays, not just the count. Any malformed snapshot capacity
          // rejects the row as a whole, like a malformed count. Rows without
          // the key are an older shape: each badge keeps its strictly
          // validated SSR cap instead.
          var fromSnapshot = row.capacity !== undefined;
          if (
            fromSnapshot &&
            row.capacity !== null &&
            (!Number.isSafeInteger(row.capacity) || row.capacity < 1)
          ) {
            showStale(key, nodes);
            return;
          }
          var snapshotCapacity = fromSnapshot ? row.capacity : null;
          var capacities = nodes.map(function (node) {
            if (fromSnapshot) return snapshotCapacity;
            return capacityFor(row, node);
          });
          nodes.forEach(function (node, index) {
            var capacity = capacities[index];
            if (capacity === undefined) return;
            node.setAttribute("data-capacity", capacity === null ? "" : String(capacity));
            var count = node.querySelector("[data-count]");
            if (count) count.textContent = countText(row.going_count, capacity);
            var spots = node.querySelector("[data-spots]");
            if (capacity === null) {
              // A lifted cap leaves no seats to count: hide the stale line
              // and, where the DOM supports it, remove it so a later read
              // cannot compute against the retired number. A newly introduced
              // cap without a spots node only moves the count; the line
              // materializes on the next full render - the binder patches
              // nodes in place, never invents markup.
              if (spots) {
                spots.hidden = true;
                if (typeof spots.remove === "function") spots.remove();
              }
            } else if (spots) {
              spots.hidden = false;
              spots.textContent = spotsLeftText(occupancy, capacity);
            }
            var ann = node.querySelector("[data-announcement]");
            if (ann && state) {
              var t = announcementText(state);
              ann.textContent = t ? t + " " : "";
            }
          });
          // One accepted snapshot per read, not per badge. Conflicting or
          // unknown legacy fallback caps cannot truthfully describe this key.
          var capacity = capacities[0];
          if (
            capacity === undefined ||
            !capacities.every(function (value) {
              return value === capacity;
            })
          ) {
            showStale(key, nodes);
            return;
          }
          // Authoritative success: the numbers are current again, so the stale
          // qualification (if any) clears. A focused retry hands to <main>;
          // focus that moved away is never stolen.
          clearStale();
          document.dispatchEvent(
            new CustomEvent(REFRESHED, {
              detail: {
                eventKey: key,
                goingCount: row.going_count,
                goingOccupancy: occupancy,
                capacity: capacity,
              },
            }),
          );
        } finally {
          releaseRead(key, request);
        }
      })
      .catch(function () {
        releaseRead(key, request);
        // Keep the last known-good numbers, qualified as stale. A superseded
        // read (aborted by a newer broadcast, or rejected after its own
        // deadline already signaled) leaves the outcome to the current owner.
        if (latest.get(key) === request) showStale(key, nodes);
      });
  }

  document.addEventListener(EVENT, function (ev) {
    var detail = (ev && ev.detail) || {};
    var nodes = nodesForKey(detail.eventKey);
    // Same-key badges share one response so they cannot disagree on counts
    // or announce different operations because their reads finished apart.
    if (nodes.length) refresh(nodes, detail.eventKey, detail.viewerState);
  });
})();
