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
  // An expired session vetoes the probe reload (the unsaved draft only exists
  // in this document) and releases the dirty guard for the recovery trip.
  var sessionExpired = false;
  editor.addEventListener("submit", function () {
    saving = true;
  });
  editor.addEventListener("input", function () {
    saving = false;
  });
  window.addEventListener("pageshow", function () {
    saving = false;
  });
  // Same bar as safeNext (src/join/service.ts): a same-origin path or nothing.
  function samePath(raw) {
    if (typeof raw !== "string" || raw === "" || /[\s\x00-\x1f\x7f]/.test(raw)) return null;
    if (raw.charAt(0) !== "/" || raw.charAt(1) === "/" || raw.indexOf("\\") >= 0) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
    try {
      var origin = window.location.origin;
      if (new URL(raw, origin).origin !== origin) return null;
    } catch {
      return null;
    }
    return raw;
  }
  window.addEventListener("two:session-expired", function (event) {
    event.preventDefault();
    sessionExpired = true;
    var detail = (event && event.detail) || {};
    var recoveryUrl =
      samePath(detail.recoveryUrl) ||
      "/auth/recover?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    var old = document.querySelector('[data-testid="admin-session-expired"]');
    if (old) old.remove();
    var notice = document.createElement("div");
    notice.setAttribute("data-testid", "admin-session-expired");
    notice.setAttribute("role", "alert");
    notice.setAttribute("tabindex", "-1");
    notice.textContent = "Your session expired. Your changes are still here. ";
    var link = document.createElement("a");
    link.href = recoveryUrl;
    link.textContent = "Sign in again";
    notice.appendChild(link);
    editor.parentNode.insertBefore(notice, editor);
    notice.focus();
  });
  window.addEventListener("beforeunload", function (event) {
    // Only the Save departure is exempt, even if loading is then stopped.
    if (saving) {
      saving = false;
      return;
    }
    // The recovery navigation must never be blocked: the draft stays in this
    // document either way, and the notice above holds the way back.
    if (sessionExpired) return;
    if (!draft && snapshot() === initial) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
