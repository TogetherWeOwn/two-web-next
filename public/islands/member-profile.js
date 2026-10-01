// MemberProfile island binder (TOG-9842, W10 slice 5).
//
// Progressive enhancement over the SSR edit form (the no-JS path posts
// `_method=PATCH` and gets a 303). Budget: exactly one PATCH per save, none
// on cancel or on client-side validation failure. No polling.
// Outcomes: saved → "Profile saved." + form closed, focus on the confirmation;
// 422 → errors in the alert, input kept; 401/302-to-login/419 → session
// expired notice with login link, input kept; anything else → save-failed
// alert, input kept. Copy and testids mirror src/islands/contracts.ts.

(function () {
  var root = document.querySelector('[data-island="member-profile"]');
  if (!root) return;
  var form = root.querySelector("form");
  if (!form) return;
  var id = root.getAttribute("data-member-id");
  var inflight = false;

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
      if (t === "profile-error" || t === "profile-save-failed" || t === "profile-session-expired") n.remove();
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

  form.addEventListener("reset", function () {
    // Cancel discards edits; focus returns to the member heading.
    clearNotices();
    setTimeout(function () {
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
    fetch("/members/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      redirect: "manual",
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (res.ok) {
          form.hidden = true;
          notice("profile-saved", "status", "Profile saved.");
          return;
        }
        if (res.status === 422) {
          return res.json().then(function (j) {
            errorList(Object.keys(j.errors || {}).map(function (k) { return j.errors[k]; }));
          });
        }
        if (res.status === 401 || res.status === 419 || res.type === "opaqueredirect" || res.status === 302) {
          return notice("profile-session-expired", "alert", "Your session expired. Your changes are still here.", true);
        }
        notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
      })
      .catch(function () {
        notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
      })
      .then(function () {
        inflight = false;
      });
  });
})();
