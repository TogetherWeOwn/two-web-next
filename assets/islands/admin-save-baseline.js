// Run before the departure controller. Provenance is guarded on two axes.
// The history entry records { path, token, clean }, where clean tracks
// whether this entry was unedited when last observed; no form contents are
// ever stored and preexisting Kit state is preserved.
//
// Back/forward traversal restores old fields: always retain the entry's
// original token so the save is refused stale with the draft preserved.
// A reload re-fetches the editor, but a browser can also restore unsaved
// old fields. Adopt the fresh GET token only when the prior entry proves
// this document was clean. A dirty or unknown entry (including legacy
// entries without a clean marker) retains the old token, because a
// restored draft must never submit under the fresh token. A previously
// unedited reload still adopts the fresh token, so a clean editor stays
// clean and legitimate post-reload edits save. When the navigation type
// cannot be determined, keep the older token: a needless stale refusal is
// recoverable, a stale overwrite is not.
//
// Restoration can also run after initialization (pageshow, or just before
// submit): if the fields changed without any user input/change, the adopted
// token's provenance is void. Submit the entry's original token instead, so
// the server refuses the restored draft rather than accepting it as current.
//
// Budget note: the bare attribute selector below is the compact form of the
// previous '[data-event-editor] input[name="saved_baseline"]' document query
// and is equivalent here because the hidden baseline lives inside the editor.
// The bare performance access relies on `?.` so a missing navigation entry
// falls through to the safe retained-token path. The saved entry check uses
// a truthy token: the token is only ever a 64-char hex digest or an empty
// failed-write marker, never another truthy value, and an empty marker is
// re-written to the fresh token rather than retained.
(function () {
  var editor = document.querySelector("[data-event-editor]");
  if (!editor) return;
  var baseline = editor.querySelector("[name=saved_baseline]");
  if (!baseline) return;
  var path = window.location.pathname;
  var token = baseline.value;
  var superseded = null;
  function snapshot() {
    var params = new URLSearchParams(new FormData(editor));
    params.delete("saved_baseline");
    return params.toString();
  }
  var initialSnapshot = snapshot();
  function save(clean) {
    try {
      var state = window.history.state || {};
      window.history.replaceState({
        ...state,
        twoAdminSaveBaseline: { path: path, token: token, clean: clean },
      });
    } catch {
      token = "";
      editor.setAttribute("data-event-draft", "");
    }
  }
  var saved = (window.history.state || {}).twoAdminSaveBaseline;
  if (saved && saved.path === path && saved.token) {
    if (
      window.performance?.getEntriesByType?.("navigation")?.[0]?.type === "reload" &&
      saved.clean === true
    ) {
      superseded = saved.token;
      save(true);
    } else {
      if (saved.token !== token) editor.setAttribute("data-event-draft", "");
      token = saved.token;
    }
  } else {
    save(true);
  }
  var on = editor.addEventListener.bind(editor);
  function edited() {
    superseded = null;
    save(false);
  }
  on("input", edited);
  on("change", edited);
  baseline.value = token;
  on("submit", function () {
    baseline.value = superseded && snapshot() !== initialSnapshot ? superseded : token;
  });
})();
