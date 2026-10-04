// GoingCount island binder (board-9689, slice 1).
//
// Progressive enhancement over the SSR badge in `renderGoingCount`:
// listens for the `going-count-updated` CustomEvent broadcast by the
// rsvp-button island after every successful write, then re-reads the
// aggregate from GET /events.json and patches the count + announcement
// nodes in place (no full re-render).
//
// Budget: one GET per answered event; non-matching keys fire nothing.
// No polling. Errors update nothing visibly (the badge keeps its last
// known-good value); the optimistic answer on the button island is the
// member-visible write confirmation.

(function () {
  var MOUNT = '[data-island="going-count"]';
  var EVENT = "going-count-updated";
  var REFRESHED = "going-count-refreshed";
  var URL = "/events.json";
  var latest = new Map();

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

  function refresh(nodes, key, state) {
    // A new broadcast owns both the read and its announcement, even if it
    // fails. An older completion must never replace the last good state.
    var request = {};
    latest.set(key, request);
    fetch(URL + "?event_key=" + encodeURIComponent(key), {
      headers: { accept: "application/json" },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("events " + res.status);
        return res.json();
      })
      .then(function (rows) {
        if (latest.get(key) !== request) return;
        var list = Array.isArray(rows) ? rows : rows && rows.data;
        if (!Array.isArray(list)) return;
        var row = list.find(function (r) {
          return r && typeof r === "object" && !Array.isArray(r) && r.event_key === key;
        });
        if (!row || !Number.isSafeInteger(row.going_count) || row.going_count < 0) return;
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
        )
          return;
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
            spots.textContent = spotsLeftText(row.going_count, capacity);
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
        )
          return;
        document.dispatchEvent(
          new CustomEvent(REFRESHED, {
            detail: { eventKey: key, goingCount: row.going_count, capacity: capacity },
          }),
        );
      })
      .catch(function () {
        // Keep the last known-good badge; the button island already
        // confirmed the write optimistically.
      });
  }

  document.addEventListener(EVENT, function (ev) {
    var detail = (ev && ev.detail) || {};
    var nodes = [];
    document.querySelectorAll(MOUNT).forEach(function (node) {
      if (node.getAttribute("data-event-key") === detail.eventKey) nodes.push(node);
    });
    // Same-key badges share one response so they cannot disagree on counts
    // or announce different operations because their reads finished apart.
    if (nodes.length) refresh(nodes, detail.eventKey, detail.viewerState);
  });
})();
