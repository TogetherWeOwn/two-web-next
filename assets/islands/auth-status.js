// Authenticated documents only. No interval, credentials or identity in tab messages.
// https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
// https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event
(function () {
  if (window.TwoAuth) return;
  var channel = null;
  var timer = null;
  var inflight = null;
  var controller = null;
  var queued = false;
  var last = 0;
  var expired = false;
  var storageKey = "two:auth-recheck";

  function recoveryUrl() {
    return "/auth/recover?next=" + encodeURIComponent(location.pathname + location.search);
  }
  function publish() {
    if (channel) channel.postMessage("recheck");
    else {
      try {
        localStorage.setItem(storageKey, String(Date.now()));
      } catch {
        /* Focus still rechecks. */
      }
    }
  }
  function loseSession() {
    if (expired) return;
    expired = true;
    // A write surface can veto navigation to keep its in-memory draft reachable.
    var event = new CustomEvent("two:session-expired", {
      cancelable: true,
      detail: { recoveryUrl: recoveryUrl() },
    });
    if (window.dispatchEvent(event)) location.reload();
  }
  function check() {
    if (expired) return Promise.resolve(false);
    if (inflight) {
      queued = true;
      return inflight;
    }
    last = Date.now();
    controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, 4000);
    inflight = fetch("/auth/status", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json().then(function (body) {
          if (Object.keys(body).length !== 1 || typeof body.authenticated !== "boolean")
            return null;
          if (!body.authenticated) loseSession();
          return body.authenticated;
        });
      })
      .catch(function () {
        return null;
      })
      .finally(function () {
        clearTimeout(timeout);
        inflight = null;
        controller = null;
        if (queued) {
          queued = false;
          schedule();
        }
      });
    return inflight;
  }
  function schedule() {
    if (timer !== null || expired) return;
    // Burst focus/visibility/tab messages coalesce; at most one probe per second.
    timer = setTimeout(
      function () {
        timer = null;
        void check();
      },
      Math.max(100, 1000 - (Date.now() - last)),
    );
  }
  function connect() {
    if (channel || typeof BroadcastChannel === "undefined") return;
    try {
      channel = new BroadcastChannel("two:auth");
      channel.onmessage = function (event) {
        if (event.data === "recheck") schedule();
      };
    } catch {
      channel = null;
    }
  }
  window.TwoAuth = {
    check: check,
    recoveryUrl: recoveryUrl,
    notify: publish,
    expired: loseSession,
  };
  connect();
  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") schedule();
  });
  window.addEventListener("storage", function (event) {
    if (event.key === storageKey && event.newValue) schedule();
  });
  window.addEventListener("pagehide", function () {
    if (channel) {
      channel.close();
      channel = null;
    }
    clearTimeout(timer);
    timer = null;
    if (controller) controller.abort();
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      connect();
      schedule();
    }
  });

  // Signal only after the same-origin logout response completed. The other tab
  // rechecks the server; a message is never itself an authentication decision.
  var form = document.querySelector('form[action="/logout"]');
  if (form) {
    var signingOut = false;
    form.addEventListener("submit", function (event) {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (signingOut) return;
      signingOut = true;
      fetch("/logout", { method: "POST", credentials: "same-origin", redirect: "manual" })
        .then(function (response) {
          if (response.type === "opaqueredirect" || response.status === 303) {
            publish();
            location.assign("/");
          } else {
            signingOut = false;
            location.reload();
          }
        })
        .catch(function () {
          signingOut = false;
        });
    });
  }
})();
