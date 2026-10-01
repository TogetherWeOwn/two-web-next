// RsvpButton island binder (TOG-9839, W10 slice 2).
//
// Progressive enhancement over the SSR mount in `src/events/pages.tsx`
// (EventPage): one PUT per join/claim click, one DELETE per withdraw/leave
// click. All controls stay disabled until the write and body settle: aborting
// a fetch cannot cancel a server transaction, so conflicting writes never overlap.
// Optimistic saving in flight (`aria-busy` on the mount, clicked control
// disabled with the saving/removing copy); on success the nodes are patched
// in place and focus moves to the new state (TOG-6956), then a
// `going-count-updated` CustomEvent `{eventKey, viewerState}` is broadcast
// for the going-count badge — the button re-reads nothing itself.
// Throttle (429) shows the CM-frozen wait copy (TOG-7976) in `role="status"`
// with the button left enabled; other failures show the failure alert with
// the button left enabled and focus untouched; 401/419/302-to-login shows
// the session-expired notice with the SSR login link (`?next=` return path,
// never the update endpoint, TOG-8135/TOG-9254) — never the native confirm
// (TOG-9354). Closed/paused SSR states carry no controls; a 403 from a stale
// page reloads into the fresh SSR (TOG-7419 clock-ended hole stays shut).
// Sync notes mirror the contract copy: a fresh write answers
// `synced_to_discord_at: null`, so success shows "Saved. Syncing to
// Discord." beside the enabled control; a stamped row renders "Synced to
// Discord." on the next SSR pass. The click island carries no trap: a bare
// click never sends a honeypot field (TOG-8715).
//
// Budget: one request per click; no polling; no GETs.

(function () {
  var MOUNT = '[data-island="rsvp-button"]';
  var EVENT = "going-count-updated";

  var COPY = {
    cta: "I'm in",
    saving: "Saving…",
    confirmed: "You're in",
    withdraw: "Can't make it",
    removing: "Removing…",
    full: "This one's full.",
    waitlistJoin: "Join the waitlist",
    waitlistFallback: "You're on the waitlist",
    waitlistClaim: "A seat opened up — I'm in",
    waitlistLeave: "Leave the waitlist",
    syncing: "Saved. Syncing to Discord.",
    syncFailed: "Saved. Discord sync didn't go through — your spot is still held.",
    synced: "Synced to Discord.",
    failedTitle: "That RSVP didn't save.",
    failedAction: "Try once more.",
    paused: "RSVPs are paused for this event — check back soon.",
    sessionExpired: "Your session expired.",
    guestCta: "Log in with Discord",
    cancelled: "Cancelled",
    draft: "Not published yet",
    past: "This one has been and gone"
  };

  var TESTID = {
    going: "rsvp-going",
    withdraw: "rsvp-withdraw",
    confirmed: "rsvp-confirmed",
    check: "rsvp-check",
    closed: "rsvp-closed",
    paused: "rsvp-paused",
    full: "event-full",
    waitlistJoin: "waitlist-join",
    waitlistPosition: "waitlist-position",
    waitlistClaim: "waitlist-claim",
    waitlistLeave: "waitlist-leave",
    syncing: "rsvp-syncing",
    syncFailed: "rsvp-sync-failed",
    synced: "rsvp-synced",
    rateLimited: "rsvp-rate-limited",
    failed: "rsvp-failed",
    sessionExpired: "rsvp-session-expired"
  };

  function throttleWaitCopy(retryAfterSeconds) {
    if (retryAfterSeconds === null || retryAfterSeconds === undefined) {
      return "Slow down — try again in a moment. Nothing changed, just wait a bit.";
    }
    var s = retryAfterSeconds === 1 ? "1 second" : retryAfterSeconds + " seconds";
    return "Slow down — try again in " + s + ". Nothing changed, just wait a moment.";
  }

  function waitlistPositionCopy(position) {
    return position === null || position === undefined
      ? COPY.waitlistFallback
      : "You're on the waitlist — #" + position + " in line";
  }

  function fullCapCopy(capacity) {
    return "Cap is " + capacity + ".";
  }

  function viewerState(status) {
    if (status === "going") return "going";
    if (status === "waitlisted") return "waitlisted";
    if (status === "withdraw") return "none";
    return "other";
  }

  var root = typeof document !== "undefined" ? document.querySelector(MOUNT) : null;
  if (!root) return;
  var eventKey = root.getAttribute("data-event-key");
  if (!eventKey) return;
  // DOM text is never assigned to href unvalidated. The SSR contract only
  // ever emits "/join/discord" or "/join/discord?next=<pct-encoded return>",
  // so accept exactly that shape, normalize the return path through
  // decode/encode, and fall back to the location-derived link otherwise.
  function safeLoginUrl(raw, fallback) {
    if (typeof raw !== "string") return fallback;
    var marker = "?next=";
    var at = raw.indexOf(marker);
    var base = at === -1 ? raw : raw.slice(0, at);
    if (base !== "/join/discord") return fallback;
    if (at === -1) return "/join/discord";
    var next;
    try {
      next = decodeURIComponent(raw.slice(at + marker.length));
    } catch (e) {
      return fallback;
    }
    return "/join/discord?next=" + encodeURIComponent(next);
  }
  var loginUrl = safeLoginUrl(
    root.getAttribute("data-login-url"),
    "/join/discord?next=" + encodeURIComponent(typeof location !== "undefined" ? location.pathname : "/")
  );
  var url = "/events/" + encodeURIComponent(eventKey) + "/rsvp";

  var controls = root.querySelector("[data-rsvp-form]") || root;
  var inflight = null;

  function clearOutcome() {
    [TESTID.rateLimited, TESTID.failed, TESTID.sessionExpired, TESTID.closed, TESTID.syncing, TESTID.synced, TESTID.syncFailed].forEach(function (t) {
      var n = root.querySelector('[data-testid="' + t + '"]');
      if (n && n.parentNode) n.parentNode.removeChild(n);
      else if (n && n.remove) n.remove();
    });
  }

  function notice(testid, role, text, withLogin, shouldFocus) {
    clearOutcome();
    var old = root.querySelector('[data-testid="' + testid + '"]');
    if (old) {
      if (old.parentNode) old.parentNode.removeChild(old);
      else if (old.remove) old.remove();
    }
    var el = document.createElement("div");
    el.setAttribute("data-testid", testid);
    el.setAttribute("role", role);
    el.setAttribute("tabindex", "-1");
    el.textContent = text;
    if (withLogin) {
      el.appendChild(document.createTextNode(" "));
      var a = document.createElement("a");
      a.href = loginUrl;
      a.textContent = COPY.guestCta;
      el.appendChild(a);
    }
    controls.appendChild(el);
    // Focus is opt-in (TOG-6956): failure/throttle keep focus put (null
    // target) — the alert announces without stealing focus. Only the
    // session-expired notice moves focus to the login path.
    if (shouldFocus === true && el.focus) el.focus();
    return el;
  }

  function setBusy(on, button, busyText) {
    if (on) root.setAttribute("aria-busy", "true");
    else root.removeAttribute("aria-busy");
    root.querySelectorAll("[data-action]").forEach(function (control) {
      control.disabled = !!on;
    });
    if (button) {
      button.disabled = !!on;
      if (on && busyText) {
        if (!button.getAttribute("data-label")) button.setAttribute("data-label", button.textContent);
        button.textContent = busyText;
      } else if (!on && button.getAttribute("data-label")) {
        button.textContent = button.getAttribute("data-label");
        button.removeAttribute("data-label");
      }
    }
  }

  function focusTestid(testids) {
    for (var i = 0; i < testids.length; i++) {
      var n = root.querySelector('[data-testid="' + testids[i] + '"]');
      if (n) {
        if (n.focus) n.focus();
        return true;
      }
    }
    return false;
  }

  function syncNote(syncedAt, syncFailed) {
    var old = root.querySelector(
      '[data-testid="' + TESTID.syncing + '"],[data-testid="' + TESTID.synced + '"],[data-testid="' + TESTID.syncFailed + '"]'
    );
    if (old) {
      if (old.parentNode) old.parentNode.removeChild(old);
      else if (old.remove) old.remove();
    }
    var el = document.createElement("p");
    if (syncFailed) {
      // TOG-6990 syncing-vs-failed: the write held the spot but the Discord
      // mirror failed. No server signal yet (writeRsvp always persists null),
      // so this branch is future-proofing for a sync_failed flag.
      el.setAttribute("data-testid", TESTID.syncFailed);
      el.setAttribute("role", "status");
      el.textContent = COPY.syncFailed;
    } else if (syncedAt) {
      el.setAttribute("data-testid", TESTID.synced);
      el.textContent = COPY.synced;
    } else {
      el.setAttribute("data-testid", TESTID.syncing);
      el.setAttribute("role", "status");
      el.textContent = COPY.syncing;
    }
    controls.appendChild(el);
  }

  function paintConfirmed() {
    // Claim path: a going PUT from the waitlist position swaps the position
    // line for the confirmation and removes the claim/leave controls.
    var claimed = root.querySelector('[data-testid="' + TESTID.waitlistPosition + '"]');
    if (claimed) {
      [TESTID.waitlistClaim, TESTID.waitlistLeave].forEach(function (t) {
        var n = root.querySelector('[data-testid="' + t + '"]');
        if (n && n.parentNode) n.parentNode.removeChild(n);
        else if (n && n.remove) n.remove();
      });
    }
    // Confirmation supersedes full for the viewer; drop it alongside the source CTAs.
    var full = root.querySelector('[data-testid="' + TESTID.full + '"]');
    if (full && full.parentNode) full.parentNode.removeChild(full);
    else if (full && full.remove) full.remove();
    // Remove every source node (join CTA(s) and/or position line) so a stale
    // duplicate can never survive beside the confirmation; the first anchors
    // the replacement.
    var sources = [];
    [TESTID.going, TESTID.waitlistJoin, TESTID.waitlistPosition].forEach(function (t) {
      var nodes;
      try {
        nodes = root.querySelectorAll('[data-testid="' + t + '"]');
      } catch (e) { nodes = null; }
      if (nodes && nodes.length !== undefined) {
        for (var i = 0; i < nodes.length; i++) sources.push(nodes[i]);
      } else {
        var single = root.querySelector('[data-testid="' + t + '"]');
        if (single) sources.push(single);
      }
    });
    // De-dupe (claimed may equal a sources entry).
    var seen = [];
    sources = sources.filter(function (n) {
      if (seen.indexOf(n) !== -1) return false;
      seen.push(n);
      return true;
    });
    var old = sources[0] || null;
    for (var k = 1; k < sources.length; k++) {
      var dup = sources[k];
      if (dup && dup.parentNode) dup.parentNode.removeChild(dup);
      else if (dup && dup.remove) dup.remove();
    }
    if (old) {
      var wrap = document.createElement("p");
      wrap.setAttribute("role", "status");
      wrap.setAttribute("data-testid", TESTID.confirmed);
      wrap.setAttribute("tabindex", "-1");
      var check = document.createElement("span");
      check.setAttribute("data-testid", TESTID.check);
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓ ";
      wrap.appendChild(check);
      wrap.appendChild(document.createTextNode(COPY.confirmed));
      if (old.parentNode) old.parentNode.replaceChild(wrap, old);
    }
    if (!root.querySelector('[data-testid="' + TESTID.withdraw + '"]')) {
      var b = document.createElement("button");
      b.setAttribute("type", "submit");
      b.setAttribute("name", "status");
      b.setAttribute("value", "withdraw");
      b.setAttribute("data-testid", TESTID.withdraw);
      b.setAttribute("data-action", "withdraw");
      b.textContent = COPY.withdraw;
      controls.appendChild(b);
      b.addEventListener("click", function (ev) {
        onAction("withdraw", b, ev);
      });
    }
    focusTestid([TESTID.confirmed]);
  }

  function paintWaitlisted(position) {
    // Join path: a waitlisted PUT swaps the join CTA(s) for the position
    // line; confirmed/withdraw leftovers from a re-answer are dropped too.
    // Full is kept (full + position).
    [TESTID.going, TESTID.waitlistJoin, TESTID.confirmed, TESTID.withdraw].forEach(function (t) {
      var n = root.querySelector('[data-testid="' + t + '"]');
      if (n && n.parentNode) n.parentNode.removeChild(n);
      else if (n && n.remove) n.remove();
    });
    var pos = root.querySelector('[data-testid="' + TESTID.waitlistPosition + '"]');
    if (!pos) {
      pos = document.createElement("p");
      pos.setAttribute("role", "status");
      pos.setAttribute("data-testid", TESTID.waitlistPosition);
      pos.setAttribute("tabindex", "-1");
      controls.appendChild(pos);
    }
    pos.textContent = waitlistPositionCopy(position === undefined ? null : position);
    if (root.getAttribute("data-full") === "true") {
      var staleClaim = root.querySelector('[data-testid="' + TESTID.waitlistClaim + '"]');
      if (staleClaim) staleClaim.remove();
    }
    if (root.getAttribute("data-full") !== "true" && root.getAttribute("data-paused") !== "true" && !root.querySelector('[data-testid="' + TESTID.waitlistClaim + '"]')) {
      var claim = document.createElement("button");
      claim.setAttribute("type", "submit");
      claim.setAttribute("name", "status");
      claim.setAttribute("value", "going");
      claim.setAttribute("data-testid", TESTID.waitlistClaim);
      claim.setAttribute("data-action", "going");
      claim.textContent = COPY.waitlistClaim;
      controls.appendChild(claim);
      claim.addEventListener("click", function (ev) {
        onAction("going", claim, ev);
      });
    }
    if (!root.querySelector('[data-testid="' + TESTID.waitlistLeave + '"]')) {
      var leave = document.createElement("button");
      leave.setAttribute("type", "submit");
      leave.setAttribute("name", "status");
      leave.setAttribute("value", "withdraw");
      leave.setAttribute("data-testid", TESTID.waitlistLeave);
      leave.setAttribute("data-action", "withdraw");
      leave.textContent = COPY.waitlistLeave;
      controls.appendChild(leave);
      leave.addEventListener("click", function (ev) {
        onAction("withdraw", leave, ev);
      });
    }
    focusTestid([TESTID.waitlistPosition]);
  }

  function paintWithdrawn() {
    var wasGoing = !!root.querySelector('[data-testid="' + TESTID.confirmed + '"]');
    var conf = root.querySelector(
      '[data-testid="' + TESTID.confirmed + '"],[data-testid="' + TESTID.waitlistPosition + '"]'
    );
    [TESTID.waitlistClaim, TESTID.waitlistLeave, TESTID.withdraw, TESTID.syncing, TESTID.synced, TESTID.syncFailed].forEach(function (t) {
      var n = root.querySelector('[data-testid="' + t + '"]');
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
    // A going withdrawal frees a seat; leaving the line does not. Neither
    // may reopen a paused event. The server remains the capacity authority.
    if (wasGoing) root.setAttribute("data-full", "false");
    if (root.getAttribute("data-paused") === "true") {
      if (conf && conf.parentNode) conf.parentNode.removeChild(conf);
      return;
    }
    var full = root.getAttribute("data-full") === "true";
    var action = full ? "waitlisted" : "going";
    var join = document.createElement("button");
    join.setAttribute("type", "submit");
    join.setAttribute("name", "status");
    join.setAttribute("value", action);
    join.setAttribute("data-testid", full ? TESTID.waitlistJoin : TESTID.going);
    join.setAttribute("data-action", action);
    join.textContent = full ? COPY.waitlistJoin : COPY.cta;
    if (conf && conf.parentNode) conf.parentNode.replaceChild(join, conf);
    else controls.appendChild(join);
    join.addEventListener("click", function (ev) { onAction(action, join, ev); });
    focusTestid([TESTID.going, TESTID.waitlistJoin]);
  }

  function broadcast(state) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT, { detail: { eventKey: eventKey, viewerState: state }, bubbles: true })
      );
    } catch (e) {
      /* a missing CustomEvent is a missing badge listener, never a failed write */
    }
  }

  function retryAfterSeconds(res) {
    try {
      var h = res.headers && res.headers.get ? res.headers.get("Retry-After") : null;
      var n = Math.ceil(Number(h));
      return Number.isFinite(n) && n >= 1 ? n : null;
    } catch (e) {
      return null;
    }
  }

  function sessionExpiredResponse(res) {
    if (!res) return false;
    if (res.status === 401 || res.status === 419) return true;
    try {
      if (res.type === "opaqueredirect" || res.status === 302) return true;
    } catch (e) {}
    return false;
  }

  function onAction(action, button, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (inflight) return;
    // SSR only renders going/waitlisted/withdraw controls; any other
    // data-action (e.g. maybe/not_going) never fires — the server stays
    // authoritative and the member sees the failure alert, never a 422
    // masquerading as confirmation.
    if (action !== "going" && action !== "waitlisted" && action !== "withdraw") {
      clearOutcome();
      setBusy(false, button);
      notice(TESTID.failed, "alert", COPY.failedTitle + " " + COPY.failedAction, false, false);
      return;
    }
    // Native disabled controls suppress activation; also guard programmatic
    // clicks and form submits. Never abort a write that may still commit.
    clearOutcome();
    var controller = {};
    inflight = controller;
    var isWithdraw = action === "withdraw";
    var method = isWithdraw ? "DELETE" : "PUT";
    setBusy(true, button, isWithdraw ? COPY.removing : COPY.saving);
    var init = {
      method: method,
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      redirect: "manual"
    };
    if (!isWithdraw) init.body = JSON.stringify({ status: action });
    fetch(url, init).then(
      function (res) {
        if (controller && inflight !== controller) return;
        if (res.ok) {
          if (isWithdraw) {
            setBusy(false, button);
            paintWithdrawn();
            broadcast(viewerState("withdraw"));
            return;
          }
          var done = function (syncedAt, syncFailed, status, position) {
            if (inflight !== controller) return;
            setBusy(false, button);
            // The FIFO service may settle a going request as waitlisted.
            // Render and broadcast the stored answer, not the requested one.
            var settled = status || action;
            if (settled === "waitlisted") {
              root.setAttribute("data-full", "true");
              paintWaitlisted(position);
            } else {
              paintConfirmed();
            }
            broadcast(viewerState(settled));
            syncNote(syncedAt, syncFailed);
          };
          if (res.status === 204) return done(null, false);
          return res
            .json()
            .then(
              function (j) {
                var d = j && j.data ? j.data : null;
                done(d ? d.synced_to_discord_at || null : null, d ? !!d.sync_failed : !!((j || {}).sync_failed),
                  d ? d.status : null, d ? d.waitlist_position : null);
              },
              function () {
                done(null, false);
              }
            );
          return;
        }
        if (sessionExpiredResponse(res)) {
          setBusy(false, button);
          notice(TESTID.sessionExpired, "alert", COPY.sessionExpired, true, true);
          return;
        }
        if (res.status === 429) {
          setBusy(false, button);
          notice(TESTID.rateLimited, "status", throttleWaitCopy(retryAfterSeconds(res)), false, false);
          return;
        }
        if (res.status === 403) {
          // Stale page (ended/paused/cancelled while open): reload into the
          // fresh SSR so the clock-ended hole stays shut. No native confirm.
          // A non-member 403 ({error:"forbidden"}) is not stale — show the
          // failure alert instead of reload-looping the same SSR controls.
          var reloadClosed = function () {
            if (controller && inflight !== controller) return;
            setBusy(false, button);
            if (typeof location !== "undefined" && location.reload) location.reload();
            else notice(TESTID.closed, "status", COPY.past, false, false);
          };
          if (res.json) {
            try {
              return res.json().then(
                function (j) {
                  if (controller && inflight !== controller) return;
                  if (j && j.error === "forbidden") {
                    setBusy(false, button);
                    notice(TESTID.failed, "alert", COPY.failedTitle + " " + COPY.failedAction, false, false);
                  } else {
                    reloadClosed();
                  }
                },
                function () { reloadClosed(); }
              );
            } catch (e) { reloadClosed(); }
          } else {
            reloadClosed();
          }
          return;
        }
        if (res.status === 409) {
          // 409 carries the authoritative cap ({capacity} in JSON); DOM
          // data-capacity is the fallback when the body is unreadable.
          var paintFull = function (capNum) {
            if (controller && inflight !== controller) return;
            setBusy(false, button);
            var msg = COPY.full + (Number.isFinite(capNum) ? " " + fullCapCopy(capNum) : "");
            var old = root.querySelector('[data-testid="' + TESTID.full + '"]');
            if (!old) {
              old = document.createElement("p");
              old.setAttribute("role", "status");
              old.setAttribute("data-testid", TESTID.full);
              old.setAttribute("tabindex", "-1");
              controls.appendChild(old);
            }
            old.textContent = msg;
            root.setAttribute("data-full", "true");
            var claim = root.querySelector('[data-testid="' + TESTID.waitlistClaim + '"]');
            if (claim) claim.remove();
            var going = root.querySelector('[data-testid="' + TESTID.going + '"]');
            if (going) {
              going.setAttribute("data-testid", TESTID.waitlistJoin);
              going.setAttribute("data-action", "waitlisted");
              going.setAttribute("value", "waitlisted");
              going.textContent = COPY.waitlistJoin;
            }
            if (old.focus) old.focus();
          };
          var domRaw = root.getAttribute("data-capacity");
          var domNum = domRaw === null || domRaw === "" ? NaN : Number(domRaw);
          if (res.json) {
            try {
              return res.json().then(
                function (j) {
                  if (controller && inflight !== controller) return;
                  var c = j ? (j.capacity !== undefined ? Number(j.capacity) : NaN) : NaN;
                  paintFull(Number.isFinite(c) ? c : domNum);
                },
                function () { paintFull(domNum); }
              );
            } catch (e) { paintFull(domNum); }
          } else {
            paintFull(domNum);
          }
          return;
        }
        setBusy(false, button);
        // Failure keeps the control enabled and focus stays put (null focus
        // target, TOG-6956): the alert announces without stealing focus.
        notice(TESTID.failed, "alert", COPY.failedTitle + " " + COPY.failedAction, false, false);
      },
      function () {
        if (controller && inflight !== controller) return;
        inflight = null;
        setBusy(false, button);
        notice(TESTID.failed, "alert", COPY.failedTitle + " " + COPY.failedAction, false, false);
      }
    ).finally(function () {
      // Keep ownership through body parsing; header arrival is not completion.
      if (inflight === controller) {
        inflight = null;
      }
    });
  }

  if (controls !== root) controls.addEventListener("submit", function (ev) {
    var button = ev.submitter || root.querySelector("[data-action]");
    onAction(button ? button.getAttribute("data-action") : null, button, ev);
  });
  var buttons = root.querySelectorAll("[data-action]");
  for (var i = 0; i < buttons.length; i++) {
    (function (b) {
      b.addEventListener("click", function (ev) {
        onAction(b.getAttribute("data-action"), b, ev);
      });
    })(buttons[i]);
  }
})();
