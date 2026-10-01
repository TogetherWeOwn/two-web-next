// Roster search/sort and other navigation must not silently discard event edits.
(function () {
  "use strict";
  var editor = document.querySelector("[data-event-editor]");
  if (!editor) return;

  function snapshot() {
    return new URLSearchParams(new FormData(editor)).toString();
  }

  var initial = snapshot();
  var saving = false;
  editor.addEventListener("submit", function () { saving = true; });
  window.addEventListener("pageshow", function () { saving = false; });
  window.addEventListener("beforeunload", function (event) {
    if (saving || snapshot() === initial) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
