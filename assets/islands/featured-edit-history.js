// Load before the editor so restored controls never acquire a fresh precondition.
(function () {
  "use strict";
  var editor = document.querySelector("[data-event-editor]");
  var baseline = document.querySelector('input[name="saved_baseline"]');
  if (!editor || !baseline) return;
  var entryBaseline = baseline.value;
  var navigation = window.performance && window.performance.getEntriesByType("navigation")[0];
  var restored = navigation && (navigation.type === "back_forward" || navigation.type === "reload");
  var history = window.history;
  try {
    if (restored) {
      entryBaseline = history && history.state && history.state.twoFeaturedBaseline;
      if (typeof entryBaseline !== "string") entryBaseline = "";
    } else {
      history.replaceState(
        Object.assign({}, history.state, { twoFeaturedBaseline: entryBaseline }),
        "",
      );
    }
  } catch {
    // An unavailable history store cannot authorize restored controls.
    entryBaseline = "";
  }
  baseline.value = entryBaseline;
  // Native restoration can run after deferred scripts; pin again on submit.
  editor.addEventListener("submit", function () {
    baseline.value = entryBaseline;
  });
  if (restored) {
    editor.setAttribute("data-event-draft", "");
    var notice = document.createElement("div");
    notice.className = "notice";
    notice.setAttribute("role", "alert");
    notice.setAttribute("data-testid", "featured-history-restored");
    notice.textContent = "This form was restored from history. Keep your draft and ";
    var link = document.createElement("a");
    link.href = window.location.pathname;
    link.textContent = "review the current version before reapplying changes";
    notice.appendChild(link);
    editor.parentNode.insertBefore(notice, editor);
  }
})();
