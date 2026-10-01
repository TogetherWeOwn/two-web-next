// MemberProfile island binder (TOG-9842, W10 slice 5).
//
// Progressive enhancement over the SSR edit form (the no-JS path posts
// `_method=PATCH` and gets a 303). Budget: exactly one PATCH per save, none
// on cancel or on client-side validation failure. No polling.
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
      if (t === "profile-error" || t === "profile-save-failed" || t === "profile-session-expired" || t === "profile-saved") n.remove();
    });
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
    var cancelled = ++generation;
    inflight = false;
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
    if (inflight) return;
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
    inflight = true;
    var request = ++generation;
    fetch("/members/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      redirect: "manual",
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (request !== generation) return;
        if (res.ok) {
          accepted(body);
          notice("profile-saved", "status", "Profile saved.");
          return;
        }
        if (res.status === 422) {
          return res.json().then(function (j) {
            if (request !== generation) return;
            errorList(Object.keys(j.errors || {}).map(function (k) { return j.errors[k]; }));
          });
        }
        if (res.status === 401 || res.status === 419 || res.type === "opaqueredirect" || res.status === 302) {
          return expiredNotice();
        }
        notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
      })
      .catch(function () {
        if (request !== generation) return;
        notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
      })
      .then(function () {
        if (request === generation) inflight = false;
      });
  });
})();
