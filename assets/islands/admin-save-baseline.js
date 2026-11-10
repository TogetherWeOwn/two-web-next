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
(function () {
  var editor = document.querySelector("[data-event-editor]");
  var baseline = document.querySelector('[data-event-editor] input[name="saved_baseline"]');
  if (!editor || !baseline) return;
  var path = window.location.pathname;
  var token = baseline.value;
  // True only when `token` is the fresh GET token whose displayed values
  // this document has proven. Entries bound to a retained old token are
  // always unproven: their initial values are already a draft.
  var freshAdopted = true;
  // Original token of this entry before any fresh adoption; null when this
  // entry had no prior binding. Guards late restoration after a clean reload.
  var superseded = null;
  // Set on the first genuine user edit. Native restoration sets values
  // without firing input/change, so a snapshot change without them is
  // restored content, not a user edit.
  var userEdited = false;
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
  function fieldSnapshot() {
    var params = new URLSearchParams(new FormData(editor));
    params.delete("saved_baseline");
    return params.toString();
  }
  var initialSnapshot = fieldSnapshot();
  var markerClean = true;
  function writeMarker(clean) {
    var state = window.history.state || {};
    window.history.replaceState(
      Object.assign({}, state, {
        twoAdminSaveBaseline: { path: path, token: token, clean: clean },
      }),
      "",
    );
    markerClean = clean;
  }
  try {
    var state = window.history.state || {};
    var saved = state.twoAdminSaveBaseline;
    if (saved && saved.path === path && typeof saved.token === "string") {
      if (navigationType() === "reload" && saved.clean === true) {
        // The prior entry proves this document was unedited, so the fresh
        // GET displays and token agree: rebind the entry to the current
        // token instead of resurrecting the old one.
        superseded = saved.token;
        freshAdopted = true;
        writeMarker(true);
      } else {
        // Bind this history entry to its original token: restored or
        // unknown provenance must refuse stale instead of overwriting the
        // latest version. A reload over a dirty or unproven entry lands
        // here too, so a restored draft is never upgraded to the fresh
        // token merely because the navigation type is reload.
        if (saved.token !== token) editor.setAttribute("data-event-draft", "");
        token = saved.token;
        superseded = null;
        freshAdopted = false;
        markerClean = false;
      }
    } else {
      // Preserve Kit's history state and never store any draft text.
      freshAdopted = true;
      writeMarker(true);
    }
  } catch {
    // Without an entry binding a restored draft cannot prove its version.
    // The existing missing-token refusal keeps that draft recoverable.
    token = "";
    editor.setAttribute("data-event-draft", "");
    freshAdopted = false;
  }
  function onUserEdit() {
    userEdited = true;
    if (!freshAdopted) return;
    // A clean document stays clean only while every value still matches the
    // fresh document. Any divergence makes this entry dirty for the next
    // reload; reverting to the fresh values clears it again.
    var clean = fieldSnapshot() === initialSnapshot;
    if (clean === markerClean) return;
    try {
      writeMarker(clean);
    } catch {
      // Without a writable entry the next reload cannot prove provenance:
      // fail closed on the missing-token refusal rather than adopt blindly.
      token = "";
      freshAdopted = false;
      editor.setAttribute("data-event-draft", "");
    }
  }
  editor.addEventListener("input", onUserEdit);
  editor.addEventListener("change", onUserEdit);
  baseline.value = token;
  editor.addEventListener("submit", function () {
    if (!userEdited && superseded !== null && fieldSnapshot() !== initialSnapshot) {
      // Late native restoration without user input: the visible fields are
      // an old draft, not the fresh document's values. Submit the entry's
      // original token so the stale refusal preserves the draft instead of
      // overwriting the latest version.
      baseline.value = superseded;
      return;
    }
    baseline.value = token;
  });
})();
