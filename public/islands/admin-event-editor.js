// Roster search/sort and other navigation must not silently discard event edits.
(function () {
  "use strict";
  var editor = document.querySelector("[data-event-editor]");
  if (!editor) return;

  function snapshot() {
    return new URLSearchParams(new FormData(editor)).toString();
  }

  var initial = snapshot();
  // A rejected Save re-renders the draft, not a new persisted baseline.
  var draft = editor.hasAttribute("data-event-draft");
  var saving = false;
  editor.addEventListener("submit", function () { saving = true; });
  editor.addEventListener("input", function () { saving = false; });
  window.addEventListener("pageshow", function () { saving = false; });
  window.addEventListener("beforeunload", function (event) {
    // Only the Save departure is exempt, even if loading is then stopped.
    if (saving) { saving = false; return; }
    if (!draft && snapshot() === initial) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
