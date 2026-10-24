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
  // One synchronous starting point for a rejected document, not a pageshow
  // reset or an async validation result that could overwrite a newer draft.
  var summary = draft && document.querySelector("[data-admin-validation-summary]");
  if (summary) summary.focus();
  var saving = false;
  // An expired session vetoes the probe reload (the unsaved draft only exists
  // in this document). Departure protection stays armed; only a normal,
  // explicit activation of the recovery link exempts that one trip.
  var leavingForRecovery = false;
  // Cancels repeat Saves; the bound stops an aborted navigation stranding the form.
  var SUBMIT_LOCK_MS = 10000;
  var locked = false;
  var lockTimer = null;
  // Both renderers provide an empty live region outside the busy form.
  var status = document.querySelector("[data-admin-save-status]");
  function announce(message) {
    if (status) status.textContent = message;
  }
  function unlock() {
    if (lockTimer !== null) clearTimeout(lockTimer);
    lockTimer = null;
    locked = false;
    // The Save departure never happened, so its one-shot exemption lapses too.
    saving = false;
    editor.removeAttribute("aria-busy");
  }
  editor.addEventListener("submit", function (event) {
    if (locked) {
      event.preventDefault();
      announce("Already saving. Please wait.");
      return;
    }
    saving = true;
    locked = true;
    editor.setAttribute("aria-busy", "true");
    announce("Saving… Please wait.");
    lockTimer = setTimeout(function () {
      unlock();
      announce("Saving is not confirmed. Check the saved record before resubmitting.");
    }, SUBMIT_LOCK_MS);
  });
  editor.addEventListener("input", function () {
    saving = false;
  });
  window.addEventListener("pageshow", function () {
    saving = false;
    leavingForRecovery = false;
    unlock();
    announce("");
  });
  // Same bar as safeNext (src/join/service.ts): a same-origin path or nothing.
  function samePath(raw) {
    if (
      typeof raw !== "string" ||
      /[\s\x00-\x1f\x7f\\]/.test(raw) ||
      raw[0] !== "/" ||
      raw[1] === "/"
    )
      return null;
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
    link.addEventListener("click", function (clickEvent) {
      if (
        clickEvent.button !== 0 ||
        clickEvent.ctrlKey ||
        clickEvent.metaKey ||
        clickEvent.shiftKey ||
        clickEvent.altKey
      )
        return;
      leavingForRecovery = true;
      setTimeout(function () {
        leavingForRecovery = false;
      }, 0);
    });
    notice.appendChild(link);
    editor.parentNode.insertBefore(notice, editor);
    notice.focus();
  });
  window.addEventListener("beforeunload", function (event) {
    // Only the Save departure is exempt, even if loading is then stopped.
    if (saving) {
      saving = false;
      leavingForRecovery = false;
      return;
    }
    // Only a normal, explicit recovery activation exempts that one trip.
    // Modified and middle clicks keep the current-document guard; an
    // interrupted recovery re-arms when its one-shot window lapses.
    if (leavingForRecovery) {
      leavingForRecovery = false;
      return;
    }
    if (!draft && snapshot() === initial) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
