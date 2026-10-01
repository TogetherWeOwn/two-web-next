// Enhances the SSR POST/_method=PATCH form: one PATCH per valid save, no polling.
// Cancel restores accepted values and ignores pending completions. Failures keep
// input; notices and focus follow src/islands/contracts.ts.

(function () {
  var root = document.querySelector('[data-island="member-profile"]');
  if (!root) return;
  var form = root.querySelector("form");
  if (!form) return;
  var id = root.getAttribute("data-member-id");
  var edit = profileElement("edit-again", root);
  var editControl = profileElement("edit-control", root);
  var inflight = false;
  var generation = 0;

  function profileElement(name, scope) {
    return (scope || document).querySelector('[data-testid="profile-' + name + '"]');
  }

  function gameNames(text) {
    var games = [];
    text.split(/\r\n|\r|\n/).forEach(function (line) {
      var game = line.trim();
      if (game && games.indexOf(game) < 0) games.push(game);
    });
    return games;
  }

  function accepted(body) {
    // Match the server's normalization; success returns no profile fields.
    var games = gameNames(body.games_text);
    var values = { bio: body.bio.trim(), games_text: games.join("\n"), timezone: body.timezone };
    var unchanged = Object.keys(values).every(function (key) {
      return form.elements[key].value === body[key];
    });
    Object.keys(values).forEach(function (key) {
      // Reset to the accepted save, not SSR.
      form.elements[key].defaultValue = values[key];
      if (unchanged) form.elements[key].value = values[key];
    });
    var bio = profileElement("bio");
    if (bio) bio.textContent = values.bio || "No bio yet.";
    var timezone = profileElement("timezone");
    if (timezone) {
      timezone.textContent = values.timezone ? "Timezone: " + values.timezone : "";
      timezone.hidden = !values.timezone;
    }
    var list = profileElement("games");
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
    var seen = gameNames(games);
    if (seen.some(function (game) { return Array.from(game).length > 80; })) {
      e.push("Keep each game name to 80 characters or fewer.");
    }
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
    if (Array.isArray(text)) {
      var ul = document.createElement("ul");
      text.forEach(function (message) {
        var li = document.createElement("li");
        li.textContent = message;
        ul.appendChild(li);
      });
      el.appendChild(ul);
    } else el.textContent = text;
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

  function saveFailed() {
    notice("profile-save-failed", "alert", "Could not save your profile. Your changes are still here — try again.");
  }

  function clearNotices() {
    root.querySelectorAll("[data-testid^='profile-']").forEach(function (n) {
      var t = n.getAttribute("data-testid");
      if (t === "profile-error" || t === "profile-save-failed" || t === "profile-session-expired" || t === "profile-saved") n.remove();
    });
  }

  function errorList(errors) {
    notice("profile-error", "alert", errors);
  }

  if (edit) edit.addEventListener("click", function () {
    clearNotices();
    form.hidden = false;
    if (editControl) editControl.hidden = true;
    var heading = root.querySelector('[id="edit-heading"]');
    if (heading) heading.focus();
  });

  form.addEventListener("reset", function () {
    // Cancel discards the draft; late completions must not repaint or unlock a newer save.
    var cancelled = ++generation;
    inflight = false;
    form.hidden = false;
    if (editControl) editControl.hidden = true;
    clearNotices();
    setTimeout(function () {
      if (cancelled !== generation) return;
      var h = profileElement("name");
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
          return notice("profile-session-expired", "alert", "Your session expired. Your changes are still here.", true);
        }
        saveFailed();
      })
      .catch(function () {
        if (request !== generation) return;
        saveFailed();
      })
      .then(function () {
        if (request === generation) inflight = false;
      });
  });
})();
