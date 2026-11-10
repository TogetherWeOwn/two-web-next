// Run before the departure controller. Back may restore old text after a GET
// renders a fresh token: bind this history entry to its original token instead.
// A reload is different: the browser re-fetches the editor and displays the
// current saved values, so the fresh token is authoritative. Adopting the
// entry's older token there would pin every later save to a stale baseline
// and mark a clean editor dirty. Genuinely restored old fields only arrive
// via back/forward traversal, which keeps the original token so the save is
// refused stale with the draft preserved instead of overwriting the latest
// version. When the navigation type cannot be determined, keep the older
// token: a needless stale refusal is recoverable, a stale overwrite is not.
(function () {
  var editor = document.querySelector("[data-event-editor]");
  var baseline = document.querySelector('[data-event-editor] input[name="saved_baseline"]');
  if (!editor || !baseline) return;
  var path = window.location.pathname;
  var token = baseline.value;
  function navigationType() {
    try {
      var perf = window.performance;
      if (perf && typeof perf.getEntriesByType === "function") {
        var entries = perf.getEntriesByType("navigation");
        if (entries && entries.length && entries[0].type) return entries[0].type;
      }
      if (perf && perf.navigation && typeof perf.navigation.type === "number") {
        // Legacy PerformanceNavigation: 1 is a reload.
        return perf.navigation.type === 1 ? "reload" : "navigate";
      }
    } catch {
      // Fall through to the safe history-token default below.
    }
    return "";
  }
  try {
    var state = window.history.state || {};
    var saved = state.twoAdminSaveBaseline;
    if (saved && saved.path === path && typeof saved.token === "string") {
      if (navigationType() === "reload") {
        // Fresh GET on this same entry: display and token agree, so rebind
        // the entry to the current token instead of resurrecting the old one.
        window.history.replaceState(
          Object.assign({}, state, {
            twoAdminSaveBaseline: { path: path, token: token },
          }),
          "",
        );
      } else {
        if (saved.token !== token) editor.setAttribute("data-event-draft", "");
        token = saved.token;
      }
    } else {
      // Preserve Kit's history state and never store any draft text.
      window.history.replaceState(
        Object.assign({}, state, {
          twoAdminSaveBaseline: { path: path, token: token },
        }),
        "",
      );
    }
  } catch {
    // Without an entry binding a restored draft cannot prove its version.
    // The existing missing-token refusal keeps that draft recoverable.
    token = "";
    editor.setAttribute("data-event-draft", "");
  }
  baseline.value = token;
  editor.addEventListener("submit", function () {
    // Native form restoration can occur after scripts and pageshow.
    baseline.value = token;
  });
})();
