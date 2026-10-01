// GoingCount island binder (TOG-9689, slice 1).
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

  function spotsLeftText(going, capacity) {
    var left = Math.max(0, capacity - going);
    return left <= 0 ? "Full" : left + " of " + capacity + " spots left";
  }

  function refresh(nodes, key, state) {
    // A new broadcast owns both the read and its announcement, even if it
    // fails. An older completion must never replace the last good state.
    var request = {};
    latest.set(key, request);
    fetch(URL + "?event_key=" + encodeURIComponent(key), { headers: { accept: "application/json" } })
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
        // displays, not just the count. An absent key is an older shape:
        // keep this refresh on the SSR cap. Any other malformed capacity
        // rejects the row as a whole, like a malformed count.
        var fromSnapshot = row.capacity !== undefined;
        if (fromSnapshot && row.capacity !== null &&
            (!Number.isSafeInteger(row.capacity) || row.capacity < 1)) return;
        var snapshotCapacity = fromSnapshot ? row.capacity : null;
        nodes.forEach(function (node) {
          var capacity;
          if (fromSnapshot) {
            capacity = snapshotCapacity;
            node.setAttribute("data-capacity", capacity === null ? "" : String(capacity));
          } else {
            var raw = node.getAttribute("data-capacity");
            capacity = raw === "" || raw === null ? null : Number(raw);
          }
          var count = node.querySelector("[data-count]");
          if (count) count.textContent = countText(row.going_count, capacity);
          var spots = node.querySelector("[data-spots]");
          if (capacity === null) {
            // A lifted cap leaves no seats to count: restore the uncapped
            // shape SSR renders (no spots line) rather than a stale number.
            // A newly introduced cap without a spots node only moves the
            // count; the line materializes on the next full render — the
            // binder patches nodes in place, never invents markup.
            if (fromSnapshot && spots && typeof spots.remove === "function") spots.remove();
          } else if (spots) {
            spots.textContent = spotsLeftText(row.going_count, capacity);
          }
          var ann = node.querySelector("[data-announcement]");
          if (ann && state) {
            var t = announcementText(state);
            ann.textContent = t ? t + " " : "";
          }
        });
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
