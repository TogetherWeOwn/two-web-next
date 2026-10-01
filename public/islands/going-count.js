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

  function refresh(nodes, key, state) {
    // A new broadcast owns both the read and its announcement, even if it
    // fails. An older completion must never replace the last good state.
    var request = {};
    latest.set(key, request);
    fetch(URL, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("events " + res.status);
        return res.json();
      })
      .then(function (rows) {
        if (latest.get(key) !== request) return;
        var list = Array.isArray(rows) ? rows : rows.data || [];
        var row = list.filter(function (r) {
          return r.event_key === key;
        })[0];
        if (!row) return;
        nodes.forEach(function (node) {
          var capacity = node.getAttribute("data-capacity");
          var count = node.querySelector("[data-count]");
          if (count) count.textContent = countText(row.going_count, capacity === "" ? null : Number(capacity));
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
