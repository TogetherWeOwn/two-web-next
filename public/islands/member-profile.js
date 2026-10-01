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
// ignores pending completions. 422 → errors in the alert, input kept; 401/302-to-login/419 → session
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
  var inflight = false;
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
    var seen = [];
    var long = false;
    games.split(/\r\n|\r|\n/).forEach(function (l) {
      var t = l.trim();
      if (Array.from(t).length > 80) long = true;
      if (t && seen.indexOf(t) < 0) seen.push(t);
    });
    if (long) e.push("Keep each game name to 80 characters or fewer.");
    if (seen.length > 20) e.push("Add no more than 20 games.");
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
      a.href = "/auth/discord?next=" + encodeURIComponent(location.pathname);
      a.textContent = "Log in with Discord";
      el.appendChild(a);
    }
    form.parentNode.insertBefore(el, form);
    el.focus();
  }

  function clearNotices() {
    root.querySelectorAll("[data-testid^='profile-']").forEach(function (n) {
      var t = n.getAttribute("data-testid");
      if (t === "profile-error" || t === "profile-save-failed" || t === "profile-session-expired" || t === "profile-saved" || t === "profile-uncertain") n.remove();
    });
  }

  function showUncertain(request) {
    // Bounded uncertain-result feedback: the save did not settle within the
    // owned deadline. The result may still have gone through, so this is a
    // role=status notice — never the save-failed alert, never a rollback.
    // The draft stays intact, nothing is resent, and ownership of feedback
    // has moved on from this request: focus stays where the member left it.
    // Timeout ownership ends here: invalidate the timed-out request so a
    // late completion can never replace newer feedback or mutate the
    // accepted baseline.
    if (request !== generation) return;
    generation++;
    var controller = currentAbort;
    clearDeadline();
    inflight = false;
    if (controller) {
      try { controller.abort(); } catch (x) {}
    }
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
    var alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.setAttribute("tabindex", "-1");
    alert.setAttribute("data-testid", "profile-error");
    var ul = document.createElement("ul");
    errors.forEach(function (m) {
      var li = document.createElement("li");
      li.textContent = m;
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
    // completion must neither change this UI nor unlock a newer request.
    // Cancel also disposes the owned deadline timer/abort listener; the next
    // save starts clean and the form is immediately usable.
    var cancelled = ++generation;
    var controller = currentAbort;
    clearDeadline();
    if (controller) {
      try { controller.abort(); } catch (x) {}
    }
    inflight = false;
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
    if (inflight) return;
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
    inflight = true;
    var request = ++generation;
    // The owned deadline covers the whole write: fetch plus response-body
    // completion. On expiry the request no longer owns feedback — late
    // completions are dropped by the generation guard, and the uncertain
    // notice is the only visible change. No automatic resend, no second
    // PATCH: the member retries explicitly after the controls release.
    if (canTimeout) {
      deadlineTimer = setTimeout(function () {
        showUncertain(request);
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
        if (res.ok) {
          clearDeadline();
          accepted(body);
          notice("profile-saved", "status", "Profile saved.");
          return;
        }
        if (res.status === 422) {
          // The owned deadline still covers the response body: keep the
          // timer until the validation payload completes. A body that
          // arrives after expiry is dropped by the generation guard.
          return res.json().then(function (j) {
            if (request !== generation) return;
            clearDeadline();
            errorList(Object.keys(j.errors || {}).map(function (k) { return j.errors[k]; }));
          });
        }
        if (res.status === 401 || res.status === 419 || res.type === "opaqueredirect" || res.status === 302) {
          clearDeadline();
          return notice("profile-session-expired", "alert", "Your session expired. Your changes are still here.", true);
        }
        clearDeadline();
        notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
      })
      .catch(function (err) {
        // The owned abort ends the request's timeout ownership: the uncertain
        // notice is already shown (or superseded), so swallow the AbortError.
        // Every other rejection is a genuine fast failure with input kept.
        if (request !== generation) return;
        clearDeadline();
        if (err && err.name === "AbortError") return;
        notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
      })
      .then(function () {
        if (request === generation) inflight = false;
      });
  });
})();
