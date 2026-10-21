// MemberProfile island binder (board-9842, W10 slice 5; save deadline board-11625).
//
// Progressive enhancement over the SSR edit form (the no-JS path posts
// `_method=PATCH` and gets a 303). Budget: exactly one PATCH per save, none
// on cancel or on client-side validation failure. No polling. One owned
// client deadline (SAVE_DEADLINE_MS, mirroring PROFILE_SAVE_DEADLINE_MS)
// covers fetch plus response-body completion: on expiry the binder aborts the
// owned fetch where AbortController exists, shows uncertain-result feedback
// with the draft intact, and releases the controls. A late completion after
// expiry changes nothing; there is no automatic resend.
// Outcomes: saved → "Profile saved." + re-edit control (or keep a newer draft),
// focus on the confirmation unless the member moved on during the save;
// Cancel resets to the last accepted values and ignores pending completions,
// but a newer save waits until the cancelled
// write settles or its deadline expires. 422 → errors in the alert, input kept; 401/302-to-login/419 → session
// expired notice with login link, input kept; 429 → throttled notice naming the
// bounded Retry-After wait, input kept, never resent; 503 with the
// profile_save_uncertain code → uncertain notice, input kept; anything else →
// save-failed alert, input kept. Refusal alerts focus only when the member has not moved
// on since the save started, like the saved confirmation. Copy and testids
// mirror src/islands/contracts.ts.
// While a write is unsettled the form is aria-busy and a polite progress line
// sits just after it; a Save press then says the earlier save is still finishing.

(function () {
  var root = document.querySelector('[data-island="member-profile"]');
  if (!root) return;
  var form = root.querySelector("form");
  if (!form) return;
  var id = root.getAttribute("data-member-id");
  var edit = root.querySelector('[data-testid="profile-edit-again"]');
  var editControl = root.querySelector('[data-testid="profile-edit-control"]');
  // pending: a PATCH is unsettled at the transport level. Cancel neither aborts
  // nor clears it (abort/ignore is not server rollback), so a newer save cannot
  // overtake an older write that may still commit. Only settlement or the owned
  // deadline (the unknown-outcome boundary) releases it. Not solved: cross-tab
  // races or a write that commits after its deadline.
  var pending = false;
  var pendingRequest = 0;
  var generation = 0;
  // Owned client deadline for one save: fetch plus response-body completion
  // (board-11625; mirrors PROFILE_SAVE_DEADLINE_MS in src/islands/contracts.ts).
  var SAVE_DEADLINE_MS = 10000;
  var abortable = typeof AbortController !== "undefined";
  // The deadline needs both timer globals; harnesses with a partial fake
  // clock (setTimeout only) get the pre-deadline admission behavior.
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";
  var deadlineTimer = null;
  var currentAbort = null;
  // editing: the member acted in the editor while the owned save was pending.
  // saveFocus: the focus owner when that save started.
  var editing = false;
  var saveFocus = null;
  // Raw text the server last accepted; a field still holding it is saved, not dirty.
  var acceptedDraft = null;

  // Busy state for an unsettled write: aria-busy on the form plus a progress
  // line. Save stays enabled and focus never moves. Only settlement or the
  // deadline ends it; Cancel keeps it, because the write is still unsettled.
  function setPending(on) {
    pending = on;
    if (on) {
      form.setAttribute("aria-busy", "true");
      progress("profile-pending", "Saving your profile\u2026");
    } else {
      form.removeAttribute("aria-busy");
      drop("profile-pending");
    }
  }

  function clearDeadline() {
    if (deadlineTimer !== null) {
      if (canTimeout) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    currentAbort = null;
  }

  var sessionExpired = false;
  var leavingForRecovery = false;

  // The leaderboard switch shares its name with a hidden 0 fallback, so
  // browsers hand back a list there: take the checkbox from it. Absent (an
  // older page) reads as no switch, and the save omits the key.
  function optOutField() {
    var named = form.elements["leaderboard_opt_out"];
    if (!named) return null;
    if (typeof named.type === "string") return named.type === "checkbox" ? named : null;
    if (typeof named.length === "number") {
      for (var i = 0; i < named.length; i++) {
        if (named[i] && named[i].type === "checkbox") return named[i];
      }
    }
    return null;
  }

  // Native 422 re-render: the controls hold the rejected draft B while the
  // server carries the persisted profile A in data-saved-* on the island
  // root. Re-pin the reset/dirty baseline to A so B counts as unsaved work
  // and native Cancel restores A, not B. Absent (ordinary GET or older
  // markup) leaves the native defaults alone. No browser storage is used.
  (function restoreSavedBaseline() {
    if (!root.getAttribute) return;
    var savedBio = root.getAttribute("data-saved-bio");
    var savedGames = root.getAttribute("data-saved-games-text");
    var savedTimezone = root.getAttribute("data-saved-timezone");
    var savedOptOut = root.getAttribute("data-saved-leaderboard-opt-out");
    if (savedBio === null && savedGames === null && savedTimezone === null && savedOptOut === null)
      return;
    // Setting defaultValue on a pristine control also rewrites its live
    // value, which would hide the rejected draft. Keep the visible B while
    // the reset/dirty baseline moves to the saved A.
    var live = {};
    ["bio", "games_text", "timezone"].forEach(function (key) {
      if (form.elements[key]) live[key] = form.elements[key].value;
    });
    if (savedBio !== null && form.elements.bio) form.elements.bio.defaultValue = savedBio;
    if (savedGames !== null && form.elements.games_text)
      form.elements.games_text.defaultValue = savedGames;
    if (savedTimezone !== null && form.elements.timezone)
      form.elements.timezone.defaultValue = savedTimezone;
    Object.keys(live).forEach(function (key) {
      form.elements[key].value = live[key];
    });
    if (savedOptOut !== null) {
      var savedSwitch = optOutField();
      if (savedSwitch) {
        // Like defaultValue, pinning defaultChecked on a pristine switch can
        // move its live state; keep the visible B while the baseline moves to A.
        var liveChecked = savedSwitch.checked;
        savedSwitch.defaultChecked = savedOptOut === "1";
        savedSwitch.checked = liveChecked;
      }
    }
  })();

  function hasUnsavedChanges() {
    var textDirty = ["bio", "games_text", "timezone"].some(function (key) {
      var field = form.elements[key];
      if (field.value === field.defaultValue) return false;
      return !acceptedDraft || field.value !== acceptedDraft[key];
    });
    if (textDirty) return true;
    var optOut = optOutField();
    return !!optOut && optOut.checked !== optOut.defaultChecked;
  }

  if (typeof window !== "undefined")
    window.addEventListener("beforeunload", function (event) {
      // Recovery navigation is the explicit escape; the notice keeps the draft
      // available in this document if the member chooses to stay.
      if (leavingForRecovery) {
        leavingForRecovery = false;
        return;
      }
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    });

  function expiredNotice() {
    sessionExpired = true;
    notice(
      "profile-session-expired",
      "alert",
      "Your session expired. Your changes are still here.",
      true,
    );
    var recoveryNotice = root.querySelector('[data-testid="profile-session-expired"]');
    var recoveryLink = recoveryNotice && recoveryNotice.querySelector("a");
    if (recoveryLink)
      recoveryLink.addEventListener("click", function (event) {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        leavingForRecovery = true;
        setTimeout(function () {
          leavingForRecovery = false;
        }, 0);
      });
  }
  if (typeof window !== "undefined")
    window.addEventListener("two:session-expired", function (event) {
      event.preventDefault();
      expiredNotice();
    });

  function accepted(body) {
    // Match the server's normalization; success returns no profile fields.
    var games = [];
    body.games_text.split(/\r\n|\r|\n/).forEach(function (line) {
      var game = line.trim();
      if (game && games.indexOf(game) < 0) games.push(game);
    });
    var values = { bio: body.bio.trim(), games_text: games.join("\n"), timezone: body.timezone };
    var unchanged = true;
    Object.keys(values).forEach(function (key) {
      if (form.elements[key].value !== body[key]) unchanged = false;
    });
    acceptedDraft = { bio: body.bio, games_text: body.games_text, timezone: body.timezone };
    // The switch is a checkbox, not text: pin its saved state so Cancel and
    // the dirty check agree with the server. Absent (an older page) leaves it.
    var optOut = optOutField();
    if (optOut && typeof body.leaderboard_opt_out === "boolean") {
      // A newer choice made while the save was pending survives its
      // acknowledgement even after focus moves away: advance only the
      // saved/reset baseline. A checkbox still holding the submitted value
      // settles cleanly.
      var newerSwitch = optOut.checked !== body.leaderboard_opt_out;
      optOut.defaultChecked = body.leaderboard_opt_out;
      if (!newerSwitch) optOut.checked = body.leaderboard_opt_out;
    }
    Object.keys(values).forEach(function (key) {
      var field = form.elements[key];
      // Setting defaultValue rewrites a pristine field, so pin the live text first.
      if (editing) field.value = field.value;
      // Native Cancel/reset now restores the latest accepted save, not SSR.
      field.defaultValue = values[key];
      // The focused field keeps its caret; untouched fields take the saved value.
      var kept = editing && field === document.activeElement;
      if (!kept && field.value === body[key]) field.value = values[key];
    });
    // Empty-state copy mirrors PROFILE_EMPTY_COPY; the binder only runs for the owner.
    var isNew = !values.bio && !games.length && !values.timezone;
    var bio = document.querySelector('[data-testid="profile-bio"]');
    if (bio)
      bio.textContent =
        values.bio || (isNew ? "New here. More soon." : "You have not added a bio yet.");
    var timezone = document.querySelector('[data-testid="profile-timezone"]');
    if (timezone)
      timezone.textContent =
        "Timezone: " + (values.timezone || "Add yours so people know when you are around.");
    var newMember = document.querySelector('[data-testid="profile-new-member"]');
    if (newMember) newMember.hidden = !isNew;
    var list = document.querySelector('[data-testid="profile-games"]');
    if (list) {
      list.textContent = "";
      var content = document.createElement(games.length ? "ul" : "p");
      if (!games.length) content.textContent = "Add the games you keep coming back to.";
      games.forEach(function (game) {
        var li = document.createElement("li");
        li.textContent = game;
        content.appendChild(li);
      });
      list.appendChild(content);
    }
    // A newer draft or any member action in the editor keeps it open.
    form.hidden = unchanged && !editing && !!edit && !!editControl;
    if (editControl) editControl.hidden = !form.hidden;
    // A successful accept clears obsolete field errors; called only while
    // the request still owns feedback (generation guard at the call site).
    clearFieldErrors();
    return unchanged;
  }

  function control(v) {
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v);
  }

  // Field association: stable ids shared with SSR pages.tsx.
  // The server `games` key maps to the `games_text` control; any other key
  // is global and stays in the summary with no fabricated control link.
  var FIELD_IDS = {
    bio: "profile-bio",
    games_text: "profile-games-text",
    timezone: "profile-timezone",
    leaderboard_opt_out: "profile-leaderboard-opt-out",
  };
  function fieldForKey(k) {
    return k === "bio"
      ? "bio"
      : k === "games" || k === "games_text"
        ? "games_text"
        : k === "timezone"
          ? "timezone"
          : k === "leaderboard_opt_out"
            ? "leaderboard_opt_out"
            : null;
  }

  function clientErrors(bio, games, tz) {
    var e = [];
    if (control(bio)) e.push({ key: "bio", text: "Remove control characters." });
    if (control(games)) e.push({ key: "games_text", text: "Remove control characters." });
    if (control(tz)) e.push({ key: "timezone", text: "Remove control characters." });
    if (Array.from(bio).length > 1000)
      e.push({ key: "bio", text: "Keep your bio to 1000 characters or fewer." });
    if (Array.from(games).length > 1700)
      e.push({ key: "games_text", text: "Games list is too long." });
    var seen = new Set();
    var long = false;
    games.split(/\r\n|\r|\n/).forEach(function (l) {
      var t = l.trim();
      if (Array.from(t).length > 80) long = true;
      if (t) seen.add(t);
    });
    if (long) e.push({ key: "games_text", text: "Keep each game name to 80 characters or fewer." });
    if (seen.size > 20) e.push({ key: "games_text", text: "Add no more than 20 games." });
    if (tz) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
      } catch {
        e.push({ key: "timezone", text: "Choose a valid IANA timezone, e.g. Europe/London." });
      }
    }
    return e;
  }

  function drop(testid) {
    var old = root.querySelector('[data-testid="' + testid + '"]');
    if (old) old.remove();
  }

  function notice(testid, role, text, loginLink, noFocus, afterForm) {
    drop(testid);
    var el = document.createElement("div");
    el.setAttribute("data-testid", testid);
    el.setAttribute("role", role);
    el.setAttribute("tabindex", "-1");
    el.textContent = text;
    if (loginLink) {
      el.appendChild(document.createTextNode(" "));
      var a = document.createElement("a");
      a.href =
        "/auth/recover?next=" + encodeURIComponent(location.pathname + (location.search || ""));
      a.textContent = "Log in with Discord";
      el.appendChild(a);
    }
    if (afterForm) form.after(el);
    else form.parentNode.insertBefore(el, form);
    if (!noFocus) el.focus();
    return el;
  }

  // Progress of an unsettled or timed-out save: a polite status, never
  // focused, placed just after the form: next to Save and outside the busy
  // form. Inserting it never moves Save.
  function progress(testid, text) {
    return notice(testid, "status", text, false, true, true);
  }

  function errorId(field) {
    return FIELD_IDS[field] + "-error";
  }

  function clearFieldErrors() {
    Object.keys(FIELD_IDS).forEach(function (field) {
      var id = errorId(field);
      var node = root.querySelector('[id="' + id + '"]');
      if (node) node.remove();
      var input = form.elements[field];
      if (!input || typeof input.setAttribute !== "function") return;
      if (typeof input.removeAttribute === "function") {
        input.removeAttribute("aria-invalid");
        var described = input.getAttribute("aria-describedby");
        if (described) {
          var kept = String(described)
            .split(/\s+/)
            .filter(function (t) {
              return t && t !== id;
            });
          if (kept.length) input.setAttribute("aria-describedby", kept.join(" "));
          else input.removeAttribute("aria-describedby");
        }
      }
    });
  }

  function wireFieldError(field, text) {
    var input = form.elements[field];
    if (!input || typeof input.setAttribute !== "function") return;
    input.setAttribute("id", FIELD_IDS[field]);
    input.setAttribute("aria-invalid", "true");
    var id = errorId(field);
    var described =
      typeof input.getAttribute === "function" ? input.getAttribute("aria-describedby") || "" : "";
    var tokens = String(described).split(/\s+/).filter(Boolean);
    if (tokens.indexOf(id) < 0) tokens.push(id);
    input.setAttribute("aria-describedby", tokens.join(" "));
    var old = root.querySelector('[id="' + id + '"]');
    var prior = old ? old.textContent + " " : "";
    if (old) old.remove();
    var p = document.createElement("p");
    p.setAttribute("id", id);
    p.setAttribute("class", "error");
    // textContent keeps server strings literal; bound by the caller.
    p.textContent = prior + String(text);
    // Beside the label, not in it: label text is the control's accessible name.
    var host = input.parentNode || form;
    host.parentNode.insertBefore(p, host.nextSibling);
  }

  function clearNotices() {
    clearFieldErrors();
    root.querySelectorAll("[data-testid^='profile-']").forEach(function (n) {
      var t = n.getAttribute("data-testid");
      if (t === "profile-session-expired" && sessionExpired) return;
      if (
        t === "profile-error" ||
        t === "profile-save-failed" ||
        t === "profile-save-throttled" ||
        t === "profile-session-expired" ||
        t === "profile-saved" ||
        t === "profile-uncertain"
      )
        n.remove();
    });
  }

  var SAVE_FAILED_COPY = "Could not save your profile. Your changes are still here — try again.";
  // Mirrors PROFILE_COPY.saveUncertain: a settled save the store cancelled
  // mid-write may still have committed, so this never claims it failed.
  var SAVE_UNCERTAIN_COPY =
    "Your save may still have gone through. Check your profile before trying again.";
  var THROTTLED_PREFIX = "Too many requests. Your changes are still here — try again in ";
  var GENERIC_INVALID_COPY = "Could not save your profile. Check the form and try again.";
  var ERROR_BOUND = 500;
  // Largest wait the throttled notice ever names (24h, like the server's
  // MAX_RETRY_DELAY_SECONDS): representable-but-absurd values cap here
  // instead of echoing raw.
  var RETRY_AFTER_CAP_SECONDS = 86400;

  // Bounded Retry-After for a throttled save, mirroring the server's
  // parseRetryAfterSeconds (src/jobs/retry-delay.ts): numeric-only
  // delta-seconds, fractions round up so the member never retries sooner than
  // asked, values under a second are unusable, absurd caps, and anything else
  // (dates, signs, words, overflow) falls back. The header wins; the JSON
  // retry_after falls back.
  function parseRetryAfterSeconds(value) {
    var raw = value === null || value === undefined ? "" : String(value).trim();
    if (!/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
    var n = Number(raw);
    if (!isFinite(n) || n * 1000 > 8000000000000000) return undefined;
    var seconds = Math.ceil(n);
    if (seconds < 1) return undefined;
    return Math.min(seconds, RETRY_AFTER_CAP_SECONDS);
  }

  function throttledCopy(seconds) {
    if (seconds === undefined) return THROTTLED_PREFIX + "a moment.";
    return THROTTLED_PREFIX + seconds + " second" + (seconds === 1 ? "" : "s") + ".";
  }

  function boundError(text) {
    var chars = Array.from(String(text));
    return chars.length > ERROR_BOUND ? chars.slice(0, ERROR_BOUND).join("") : chars.join("");
  }

  function isSavedAck(j) {
    return !!j && typeof j === "object" && !Array.isArray(j) && j.saved === true;
  }

  function validationMessages(j) {
    var out = [];
    if (j && typeof j === "object" && !Array.isArray(j)) {
      var bag = j.errors;
      if (bag && typeof bag === "object" && !Array.isArray(bag)) {
        Object.keys(bag).forEach(function (k) {
          var m = bag[k];
          if (typeof m === "string" && m.trim() !== "")
            out.push({ key: fieldForKey(k), text: boundError(m) });
        });
      }
    }
    return out.length ? out : [{ key: null, text: GENERIC_INVALID_COPY }];
  }

  // A delayed refusal respects deliberate newer work exactly as a delayed
  // success does: it focuses its summary only when the member has not moved
  // on since the save started. Decided at settle time (when the body
  // completes), not at headers time, so editing done while the body streams
  // still counts. Synchronous client validation passes no request and always
  // focuses.
  function hasMovedOn() {
    return editing || document.activeElement !== saveFocus;
  }

  function saveFailed(noFocus) {
    notice("profile-save-failed", "alert", SAVE_FAILED_COPY, false, noFocus);
  }

  // A throttled save keeps the draft and names the bounded wait; nothing is
  // resent, and the member retries with the ordinary Save. Decided at settle
  // time with the generation guard, like the 422 payload, so a body that
  // arrives after Cancel stays inert.
  function saveThrottled(res, request) {
    var headerSeconds;
    try {
      headerSeconds =
        res.headers && typeof res.headers.get === "function"
          ? parseRetryAfterSeconds(res.headers.get("Retry-After"))
          : undefined;
    } catch {
      headerSeconds = undefined;
    }
    var show = function (seconds) {
      if (request !== generation) return;
      notice("profile-save-throttled", "alert", throttledCopy(seconds), false, hasMovedOn());
    };
    if (headerSeconds !== undefined) {
      show(headerSeconds);
      return;
    }
    var fromBody = function (j) {
      if (request !== generation) return;
      show(
        j && typeof j === "object" && !Array.isArray(j)
          ? parseRetryAfterSeconds(j.retry_after)
          : undefined,
      );
    };
    var noBody = function () {
      if (request !== generation) return;
      show(undefined);
    };
    try {
      var payload = res.json();
      if (payload && typeof payload.then === "function") {
        payload.then(fromBody, noBody);
        return;
      }
      fromBody(payload);
    } catch {
      noBody();
    }
  }

  // A settled 503 is either definitely failed (safe to retry) or a cancelled
  // write that may still have committed: only the profile_save_uncertain code
  // owns the uncertain notice, everything else keeps the failed-safe alert.
  function settledUnavailable(res, request) {
    var settle = function (j) {
      if (request !== generation) return;
      if (j && typeof j === "object" && !Array.isArray(j) && j.error === "profile_save_uncertain") {
        notice("profile-uncertain", "status", SAVE_UNCERTAIN_COPY, false, hasMovedOn());
      } else {
        saveFailed(hasMovedOn());
      }
    };
    var unproven = function () {
      if (request !== generation) return;
      saveFailed(hasMovedOn());
    };
    try {
      var outcome = res.json();
      if (outcome && typeof outcome.then === "function") {
        outcome.then(settle, unproven);
        return;
      }
      settle(outcome);
    } catch {
      unproven();
    }
  }

  function expire(request) {
    // Deadline expiry is the documented unknown-outcome boundary: the request
    // is abandoned (aborted where possible) and the pending guard released, so
    // the member may retry explicitly. This holds for a cancelled write too.
    if (!pending || request !== pendingRequest) return;
    var controller = currentAbort;
    clearDeadline();
    setPending(false);
    if (controller) {
      try {
        controller.abort();
      } catch {}
    }
    // A cancelled write no longer owns feedback: release it silently.
    if (request !== generation) return;
    // Bounded uncertain-result feedback: the save did not settle within the
    // owned deadline. The result may still have gone through, so this is a
    // role=status notice — never the save-failed alert, never a rollback.
    // The draft stays intact, nothing is resent, and ownership of feedback
    // has moved on from this request: focus stays where the member left it.
    // Invalidate the timed-out request so a late completion can never replace
    // newer feedback or mutate the accepted baseline.
    // The notice takes the place of the progress line the member was watching;
    // unlike a repeat press it does not scroll, because the member may be typing.
    generation++;
    progress(
      "profile-uncertain",
      "Still saving — this is taking longer than expected. It may still have gone through; wait a moment, then save again if nothing changed.",
    );
  }

  function errorList(errors, noFocus) {
    clearFieldErrors();
    var old = root.querySelector('[data-testid="profile-error"]');
    if (old) old.remove();
    var list =
      Array.isArray(errors) && errors.length ? errors : [{ key: null, text: GENERIC_INVALID_COPY }];
    // Inline errors first so the summary links resolve to live nodes.
    list.forEach(function (e) {
      if (e && e.key && FIELD_IDS[e.key]) wireFieldError(e.key, e.text);
    });
    var alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.setAttribute("tabindex", "-1");
    alert.setAttribute("data-testid", "profile-error");
    var ul = document.createElement("ul");
    list.forEach(function (e) {
      var li = document.createElement("li");
      var text = e && typeof e.text === "string" ? boundError(e.text) : GENERIC_INVALID_COPY;
      if (e && e.key && FIELD_IDS[e.key] && form.elements[e.key]) {
        var a = document.createElement("a");
        a.setAttribute("href", "#" + FIELD_IDS[e.key]);
        // textContent keeps server strings literal; bound above for 422 maps.
        a.textContent = text;
        (function (control) {
          // Summary-link activation focuses the control without changing
          // values; keyboard Enter fires click, so one handler covers both.
          a.addEventListener("click", function (ev) {
            ev.preventDefault();
            control.focus();
          });
        })(form.elements[e.key]);
        li.appendChild(a);
      } else {
        li.textContent = text;
      }
      ul.appendChild(li);
    });
    alert.appendChild(ul);
    form.parentNode.insertBefore(alert, form);
    if (!noFocus) alert.focus();
  }

  function openEditor() {
    clearNotices();
    form.hidden = false;
    if (editControl) editControl.hidden = true;
    var heading = root.querySelector('[id="edit-heading"]');
    if (heading) heading.focus();
  }

  if (edit) edit.addEventListener("click", openEditor);

  // The new-member call to action jumps to the editor; reopen it first when a
  // save has collapsed it. Without script the plain #edit-heading link works.
  var cta = document.querySelector('[data-testid="profile-new-member-cta"]');
  if (cta)
    cta.addEventListener("click", function (ev) {
      ev.preventDefault();
      openEditor();
    });

  form.addEventListener("reset", function () {
    // Cancel discards the draft, not an already accepted server write. A late
    // completion must not change this UI. Cancel does not abort the pending
    // write (abort is not server rollback): it keeps its owned deadline, and
    // the guard holds until it settles or expires.
    var cancelled = ++generation;
    sessionExpired = false;
    leavingForRecovery = false;
    form.hidden = false;
    if (editControl) editControl.hidden = true;
    clearNotices();
    // The draft that "still finishing" promised to keep is gone: an unsettled
    // write goes back to the plain saving line.
    if (pending) setPending(true);
    setTimeout(function () {
      if (cancelled !== generation) return;
      var h = document.querySelector('[data-testid="profile-name"]');
      if (h) h.focus();
    }, 0);
  });

  // Detection only offers a shortcut; it never changes a saved or live draft.
  // Keep the browser's alias verbatim and leave final validation to the server.
  (function deviceTimezoneHelper() {
    var helper = root.querySelector("[data-device-timezone]");
    var button = root.querySelector("[data-device-timezone-use]");
    var field = form.elements.timezone;
    if (!helper || !button || !field) return;
    var zone;
    try {
      zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof zone !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone))
        return;
      new Intl.DateTimeFormat("en", { timeZone: zone });
    } catch {
      return;
    }
    button.addEventListener("click", function () {
      field.value = zone;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    helper.hidden = false;
  })();

  // Member work in the editor during an owned save: keep their focus, caret and draft.
  ["keydown", "pointerdown", "focusin", "input"].forEach(function (type) {
    form.addEventListener(type, function () {
      if (pending) editing = true;
    });
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    // The press is not queued: say so politely, keep focus and the draft. The
    // member is at Save, so bring the whole line into view (on a phone its end
    // can fall below the page); the first press never scrolls, so a quick
    // second click still lands on Save.
    if (pending)
      return progress(
        "profile-pending",
        "Still finishing your earlier save. Your changes are kept; press Save again in a moment.",
      ).scrollIntoView({ block: "nearest" });
    if (sessionExpired) return expiredNotice();
    var f = form.elements;
    var body = {
      bio: f.bio.value,
      games_text: f.games_text.value,
      timezone: f.timezone.value,
      website: f.website ? f.website.value : "",
      formOpenedAt: Number(f.formOpenedAt.value),
    };
    // Always explicit while the switch exists; absent (an older page) omits
    // the key so the server preserves the stored choice.
    var switchField = optOutField();
    if (switchField) body.leaderboard_opt_out = switchField.checked;
    clearNotices();
    var errs = clientErrors(body.bio, body.games_text, body.timezone);
    if (errs.length) return errorList(errs);
    editing = false;
    saveFocus = document.activeElement;
    var request = ++generation;
    pendingRequest = request;
    setPending(true);
    // The owned deadline covers the whole write: fetch plus response-body
    // completion. On expiry the request no longer owns feedback — late
    // completions are dropped by the generation guard, and the uncertain
    // notice is the only visible change. No automatic resend, no second
    // PATCH: the member retries explicitly after the controls release.
    if (canTimeout) {
      deadlineTimer = setTimeout(function () {
        expire(request);
      }, SAVE_DEADLINE_MS);
    }
    var init = {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      redirect: "manual",
      body: JSON.stringify(body),
    };
    if (abortable) {
      currentAbort = new AbortController();
      init.signal = currentAbort.signal;
    }
    fetch("/members/" + encodeURIComponent(id), init)
      .then(function (res) {
        if (request !== generation) return;
        if (res.status === 422) {
          // The owned deadline still covers the response body: keep the
          // timer until the validation payload completes. A body that
          // arrives after expiry is dropped by the generation guard.
          var invalid = function (j) {
            if (request !== generation) return;
            errorList(validationMessages(j), hasMovedOn());
          };
          var rejected = function () {
            if (request !== generation) return;
            errorList([], hasMovedOn());
          };
          try {
            var problems = res.json();
            if (problems && typeof problems.then === "function")
              return problems.then(invalid, rejected);
            invalid(problems);
          } catch {
            rejected();
          }
          return;
        }
        if (res.ok) {
          // The save counts only with the server's explicit acknowledgement.
          // Any other 2xx body keeps the draft and reports a retryable failure.
          var admit = function (j) {
            if (request !== generation) return;
            if (isSavedAck(j)) {
              // Read focus before accepted() may collapse a focused editor.
              var movedOn = editing || document.activeElement !== saveFocus;
              var unchanged = accepted(body);
              notice("profile-saved", "status", "Profile saved.", false, movedOn || !unchanged);
            } else {
              saveFailed(hasMovedOn());
            }
          };
          var unproven = function () {
            if (request !== generation) return;
            saveFailed(hasMovedOn());
          };
          try {
            var ack = res.json();
            if (ack && typeof ack.then === "function") return ack.then(admit, unproven);
            admit(ack);
          } catch {
            unproven();
          }
          return;
        }
        if (
          res.status === 401 ||
          res.status === 419 ||
          res.type === "opaqueredirect" ||
          res.status === 302
        ) {
          return expiredNotice();
        }
        if (res.status === 429) return saveThrottled(res, request);
        if (res.status === 503) return settledUnavailable(res, request);
        saveFailed(hasMovedOn());
      })
      .catch(function (err) {
        // The owned abort ends the request's timeout ownership: the uncertain
        // notice is already shown (or superseded), so swallow the AbortError.
        // Every other rejection is a genuine fast failure with input kept.
        if (request !== generation) return;
        if (err && err.name === "AbortError") return;
        saveFailed(hasMovedOn());
      })
      .then(function () {
        // Settlement owns the transport state, cancelled or not: release the
        // guard and dispose the deadline. An expired request has already
        // released both, and a newer request owns them now.
        if (!pending || pendingRequest !== request) return;
        setPending(false);
        clearDeadline();
      });
  });
})();
