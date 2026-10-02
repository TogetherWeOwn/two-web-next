// MemberProfile island binder (TOG-9842, W10 slice 5; save deadline TOG-11625).
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
// focus on the confirmation; Cancel resets to the last accepted values and
// ignores pending completions, but a newer save waits until the cancelled
// write settles or its deadline expires. 422 → errors in the alert, input kept; 401/302-to-login/419 → session
// expired notice with login link, input kept; anything else → save-failed
// alert, input kept. Copy and testids mirror src/islands/contracts.ts.

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
  // (TOG-11625; mirrors PROFILE_SAVE_DEADLINE_MS in src/islands/contracts.ts).
  var SAVE_DEADLINE_MS = 10000;
  var abortable = typeof AbortController !== "undefined";
  // The deadline needs both timer globals; harnesses with a partial fake
  // clock (setTimeout only) get the pre-deadline admission behavior.
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";
  var deadlineTimer = null;
  var currentAbort = null;

  function clearDeadline() {
    if (deadlineTimer !== null) {
      if (canTimeout) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    currentAbort = null;
  }

  var sessionExpired = false;

  function expiredNotice() {
    sessionExpired = true;
    notice("profile-session-expired", "alert", "Your session expired. Your changes are still here.", true);
  }
  if (typeof window !== "undefined") window.addEventListener("two:session-expired", function (event) {
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
    Object.keys(values).forEach(function (key) {
      // Native Cancel/reset now restores the latest accepted save, not SSR.
      form.elements[key].defaultValue = values[key];
      if (unchanged) form.elements[key].value = values[key];
    });
    var bio = document.querySelector('[data-testid="profile-bio"]');
    if (bio) bio.textContent = values.bio || "No bio yet.";
    var timezone = document.querySelector('[data-testid="profile-timezone"]');
    if (timezone) {
      timezone.textContent = values.timezone ? "Timezone: " + values.timezone : "";
      timezone.hidden = !values.timezone;
    }
    var list = document.querySelector('[data-testid="profile-games"]');
    if (list) {
      list.textContent = "";
      var content = document.createElement(games.length ? "ul" : "p");
      if (!games.length) content.textContent = "No games listed yet.";
      games.forEach(function (game) {
        var li = document.createElement("li");
        li.textContent = game;
        content.appendChild(li);
      });
      list.appendChild(content);
    }
    // If a newer draft was typed while saving, keep it reachable too.
    form.hidden = unchanged && !!edit && !!editControl;
    if (editControl) editControl.hidden = !form.hidden;
  }

  function control(v) {
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v);
  }

  function clientErrors(bio, games, tz) {
    var e = [];
    if (control(bio) || control(games) || control(tz)) e.push("Remove control characters.");
    if (Array.from(bio).length > 1000) e.push("Keep your bio to 1000 characters or fewer.");
    var seen = new Set();
    var long = false;
    games.split(/\r\n|\r|\n/).forEach(function (l) {
      var t = l.trim();
      if (Array.from(t).length > 80) long = true;
      if (t) seen.add(t);
    });
    if (long) e.push("Keep each game name to 80 characters or fewer.");
    if (seen.size > 20) e.push("Add no more than 20 games.");
    if (tz) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
      } catch (x) {
        e.push("Choose a valid IANA timezone, e.g. Europe/London.");
      }
    }
    return e;
  }

  function notice(testid, role, text, loginLink) {
    var old = root.querySelector('[data-testid="' + testid + '"]');
    if (old) old.remove();
    var el = document.createElement("div");
    el.setAttribute("data-testid", testid);
    el.setAttribute("role", role);
    el.setAttribute("tabindex", "-1");
    el.textContent = text;
    if (loginLink) {
      el.appendChild(document.createTextNode(" "));
      var a = document.createElement("a");
      a.href = "/auth/recover?next=" + encodeURIComponent(location.pathname + (location.search || ""));
      a.textContent = "Log in with Discord";
      el.appendChild(a);
    }
    form.parentNode.insertBefore(el, form);
    el.focus();
  }

  function clearNotices() {
    root.querySelectorAll("[data-testid^='profile-']").forEach(function (n) {
      var t = n.getAttribute("data-testid");
      if (t === "profile-session-expired" && sessionExpired) return;
      if (t === "profile-error" || t === "profile-save-failed" || t === "profile-session-expired" || t === "profile-saved" || t === "profile-uncertain") n.remove();
    });
  }

  var SAVE_FAILED_COPY = "Could not save your profile. Your changes are still here — try again.";
  var GENERIC_INVALID_COPY = "Could not save your profile. Check the form and try again.";
  var ERROR_BOUND = 500;

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
          if (typeof m === "string" && m.trim() !== "") out.push(boundError(m));
        });
      }
    }
    return out.length ? out : [GENERIC_INVALID_COPY];
  }

  function saveFailed() {
    notice("profile-save-failed", "alert", SAVE_FAILED_COPY);
  }

  function expire(request) {
    // Deadline expiry is the documented unknown-outcome boundary: the request
    // is abandoned (aborted where possible) and the pending guard released, so
    // the member may retry explicitly. This holds for a cancelled write too.
    if (!pending || request !== pendingRequest) return;
    var controller = currentAbort;
    clearDeadline();
    pending = false;
    if (controller) {
      try { controller.abort(); } catch (x) {}
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
    generation++;
    var old = root.querySelector('[data-testid="profile-uncertain"]');
    if (old) old.remove();
    var el = document.createElement("div");
    el.setAttribute("data-testid", "profile-uncertain");
    el.setAttribute("role", "status");
    el.textContent = "Still saving — this is taking longer than expected. It may still have gone through; wait a moment, then save again if nothing changed.";
    form.parentNode.insertBefore(el, form);
  }

  function errorList(errors) {
    var old = root.querySelector('[data-testid="profile-error"]');
    if (old) old.remove();
    var list = Array.isArray(errors) && errors.length ? errors : [GENERIC_INVALID_COPY];
    var alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.setAttribute("tabindex", "-1");
    alert.setAttribute("data-testid", "profile-error");
    var ul = document.createElement("ul");
    list.forEach(function (m) {
      var li = document.createElement("li");
      // textContent keeps server strings literal; bound above for 422 maps.
      li.textContent = typeof m === "string" ? boundError(m) : GENERIC_INVALID_COPY;
      ul.appendChild(li);
    });
    alert.appendChild(ul);
    form.parentNode.insertBefore(alert, form);
    alert.focus();
  }

  if (edit) edit.addEventListener("click", function () {
    clearNotices();
    form.hidden = false;
    if (editControl) editControl.hidden = true;
    var heading = root.querySelector('[id="edit-heading"]');
    if (heading) heading.focus();
  });

  form.addEventListener("reset", function () {
    // Cancel discards the draft, not an already accepted server write. A late
    // completion must not change this UI. Cancel does not abort the pending
    // write (abort is not server rollback): it keeps its owned deadline, and
    // the guard holds until it settles or expires.
    var cancelled = ++generation;
    sessionExpired = false;
    form.hidden = false;
    if (editControl) editControl.hidden = true;
    clearNotices();
    setTimeout(function () {
      if (cancelled !== generation) return;
      var h = document.querySelector('[data-testid="profile-name"]');
      if (h) h.focus();
    }, 0);
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (pending) return;
    if (sessionExpired) return expiredNotice();
    var f = form.elements;
    var body = {
      bio: f.bio.value,
      games_text: f.games_text.value,
      timezone: f.timezone.value,
      website: f.website ? f.website.value : "",
      formOpenedAt: Number(f.formOpenedAt.value),
    };
    clearNotices();
    var errs = clientErrors(body.bio, body.games_text, body.timezone);
    if (errs.length) return errorList(errs);
    pending = true;
    var request = ++generation;
    pendingRequest = request;
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
            errorList(validationMessages(j));
          };
          var rejected = function () {
            if (request !== generation) return;
            errorList([]);
          };
          try {
            var problems = res.json();
            if (problems && typeof problems.then === "function") return problems.then(invalid, rejected);
            invalid(problems);
          } catch (e) {
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
              accepted(body);
              notice("profile-saved", "status", "Profile saved.");
            } else {
              saveFailed();
            }
          };
          var unproven = function () {
            if (request !== generation) return;
            saveFailed();
          };
          try {
            var ack = res.json();
            if (ack && typeof ack.then === "function") return ack.then(admit, unproven);
            admit(ack);
          } catch (e) {
            unproven();
          }
          return;
        }
        if (res.status === 401 || res.status === 419 || res.type === "opaqueredirect" || res.status === 302) {
          return expiredNotice();
        }
        saveFailed();
      })
      .catch(function (err) {
        // The owned abort ends the request's timeout ownership: the uncertain
        // notice is already shown (or superseded), so swallow the AbortError.
        // Every other rejection is a genuine fast failure with input kept.
        if (request !== generation) return;
        if (err && err.name === "AbortError") return;
        saveFailed();
      })
      .then(function () {
        // Settlement owns the transport state, cancelled or not: release the
        // guard and dispose the deadline. An expired request has already
        // released both, and a newer request owns them now.
        if (!pending || pendingRequest !== request) return;
        pending = false;
        clearDeadline();
      });
  });
})();
