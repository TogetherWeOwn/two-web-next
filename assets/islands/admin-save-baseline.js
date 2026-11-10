// Run before the departure controller. Back may restore old text after a GET
// renders a fresh token: bind this history entry to its original token instead.
(function () {
  "use strict";
  var editor = document.querySelector("[data-event-editor]");
  var baseline = document.querySelector('[data-event-editor] input[name="saved_baseline"]');
  if (!editor || !baseline) return;
  var token = baseline.value;
  try {
    var state = window.history.state || {};
    var saved = state.twoAdminSaveBaseline;
    if (saved && saved.path === window.location.pathname && typeof saved.token === "string") {
      if (saved.token !== token) editor.setAttribute("data-event-draft", "");
      token = saved.token;
    } else {
      // Preserve Kit's history state and never store any draft text.
      window.history.replaceState(
        Object.assign({}, state, {
          twoAdminSaveBaseline: { path: window.location.pathname, token: token },
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
