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
    clearTimeout(lockTimer);
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
  window.addEventListener("pageshow", function () {
    leavingForRecovery = false;
    unlock();
    announce("");
  });
  // Same bar as safeNext (src/join/service.ts): a same-origin path or nothing.
  function samePath(raw) {
    // A single leading slash with no backslash or whitespace is rooted on
    // this origin; it cannot be a protocol-relative or scheme URL.
    if (
      typeof raw !== "string" ||
      /[\s\x00-\x1f\x7f\\]/.test(raw) ||
      raw[0] !== "/" ||
      raw[1] === "/"
    )
      return null;
    return raw;
  }
  window.addEventListener("two:session-expired", function (event) {
    event.preventDefault();
    var detail = event.detail || {};
    var recoveryUrl =
      samePath(detail.recoveryUrl) ||
      "/auth/recover?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    document.querySelector('[data-testid="admin-session-expired"]')?.remove();
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
  var reviewLink = document.querySelector('[data-testid="review-event"]');
  // Both renderers emit the canonical saved-review URL ending in ?review=1.
  var reviewHref = reviewLink && reviewLink.href;
  function onEdit() {
    saving = false;
    if (reviewLink)
      reviewLink.href = reviewHref + (draft || snapshot() !== initial ? "&unsaved=1" : "");
  }
  // New-tab and context-menu navigation use href without a click handler.
  onEdit();
  editor.addEventListener("input", onEdit);
  editor.addEventListener("change", onEdit);
  window.addEventListener("beforeunload", function (event) {
    // Only Save or a normal, explicit recovery activation exempts one trip.
    // Modified/middle recovery clicks keep the current-document guard.
    if (saving || leavingForRecovery) {
      saving = leavingForRecovery = false;
      return;
    }
    if (!draft && snapshot() === initial) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
