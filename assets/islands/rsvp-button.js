// RsvpButton island binder (board-9839, W10 slice 2).
//
// Progressive enhancement over the SSR mount in `src/events/pages.tsx`
// (EventPage): one PUT per join/claim click, one DELETE per withdraw/leave
// click. All controls stay disabled until the write and body settle: aborting
// a fetch cannot cancel a server transaction, so conflicting writes never overlap.
// Optimistic saving in flight (`aria-busy` on the mount, clicked control
// disabled with the saving/removing copy); on success the nodes are patched
// in place and focus moves to the new state (board-6956) unless the member
// has moved focus or pressed outside the widget since the write started, then a
// `going-count-updated` CustomEvent `{eventKey, viewerState}` is broadcast
// for the going-count badge — the button re-reads nothing itself.
// Throttle (429) shows the CM-frozen wait copy (board-7976) in `role="status"`
// with the button left enabled; refused writes show the failure alert with
// retry enabled and focus restored to that control (disabling it in flight
// drops focus to BODY). Response-less transport requires SSR
// recovery with mutations disabled; 401/419/302-to-login shows
// the session-expired notice with the recovery link (or SSR guest login link).
// Both carry a page return path, never the update endpoint (board-8135, board-9254)
// or the native confirm (board-9354). Closed/paused SSR states carry no controls; a 403 from a stale
// page reloads into the fresh SSR (board-7419 clock-ended hole stays shut).
// Sync notes mirror the contract copy: a fresh write answers
// `synced_to_discord_at: null`, so success shows "Saved. Syncing to
// Discord." beside the enabled control; a stamped row renders "Synced to
// Discord." on the next SSR pass. The click island carries no trap: a bare
// click never sends a honeypot field (board-8715).
// Honest DELETE: a withdraw that deletes no caller row answers 404
// {error: not_found}. The member's wanted end state is already "no row",
// so a 404 on withdraw converges like a 204 — paint withdrawn and broadcast
// none — covering a second DELETE, a cross-tab double-withdraw, and a retry
// after a lost 204. Any other 404 (a PUT for an unknown key) keeps the
// failure alert.
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
    waitlistSeatTaken: "Someone just took that seat.",
    syncing: "Saved. Syncing to Discord.",
    syncFailed: "Saved. Discord sync didn't go through — your spot is still held.",
    synced: "Synced to Discord.",
    failedTitle: "That RSVP didn't save.",
    failedAction: "Try once more.",
    unknown: "We couldn't confirm your RSVP. Check the event before trying again.",
    refresh: "Refresh the event",
    paused: "RSVPs are paused for this event — check back soon.",
    sessionExpired: "Your session expired.",
    guestCta: "Log in with Discord",
    cancelled: "Cancelled",
    draft: "Not published yet",
    past: "This one has been and gone",
  };

  var TESTID = {
    going: "rsvp-going",
    withdraw: "rsvp-withdraw",
    confirmed: "rsvp-confirmed",
    maybe: "rsvp-maybe",
    notGoing: "rsvp-not-going",
    check: "rsvp-check",
    closed: "rsvp-closed",
    paused: "rsvp-paused",
    full: "event-full",
    waitlistJoin: "waitlist-join",
    waitlistPosition: "waitlist-position",
    waitlistClaim: "waitlist-claim",
    waitlistLeave: "waitlist-leave",
    waitlistSeatTaken: "waitlist-seat-taken",
    syncing: "rsvp-syncing",
    syncFailed: "rsvp-sync-failed",
    synced: "rsvp-synced",
    rateLimited: "rsvp-rate-limited",
    failed: "rsvp-failed",
    unknown: "rsvp-unknown",
    refresh: "rsvp-refresh",
    sessionExpired: "rsvp-session-expired",
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
    } catch {
      return fallback;
    }
    return "/join/discord?next=" + encodeURIComponent(next);
  }
  // Only the shared recovery landing may replace the guest sign-in link.
  // Rebuild its query so response data cannot become an executable href.
  function safeRecoveryUrl(raw) {
    var prefix = "/auth/recover?next=";
    if (typeof raw !== "string" || raw.indexOf(prefix) !== 0) return null;
    try {
      return prefix + encodeURIComponent(decodeURIComponent(raw.slice(prefix.length)));
    } catch {
      return null;
    }
  }
  var loginUrl = safeLoginUrl(
    root.getAttribute("data-login-url"),
    "/join/discord?next=" +
      encodeURIComponent(typeof location !== "undefined" ? location.pathname : "/"),
  );
  // Unknown-outcome recovery keeps the member on the attendee page they
  // were already on (?attendees=N), never dropping to page 1. The live
  // page URL is preferred when its path is this event; otherwise the SSR
  // sign-in `next` path is used only if it is the same event. Mount data
  // is untrusted: the href is always rebuilt from eventKey, and only a
  // positive-integer attendees value (>1) is carried over. Anything else
  // falls back to the bare event.
  function isSameEventPath(pathname) {
    if (typeof pathname !== "string") return false;
    try {
      if (decodeURIComponent(pathname) === "/e/" + eventKey) return true;
    } catch {
      return false;
    }
    return pathname === "/e/" + encodeURIComponent(eventKey);
  }
  function attendeesSuffix(search) {
    if (typeof search !== "string" || search === "") return "";
    var raw = null;
    try {
      var q = search.charAt(0) === "?" ? search.slice(1) : search;
      raw = new URLSearchParams(q).get("attendees");
    } catch {
      return "";
    }
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || raw === "1") return "";
    return "?attendees=" + raw;
  }
  function safeRefreshHref() {
    var base = "/e/" + encodeURIComponent(eventKey);
    try {
      var loc =
        typeof location !== "undefined" && location
          ? location
          : typeof document !== "undefined" && document.location
            ? document.location
            : null;
      if (loc && isSameEventPath(loc.pathname)) return base + attendeesSuffix(loc.search || "");
    } catch {
      // fall through to the validated returnTo below, then the bare event
    }
    // Validated SSR returnTo fallback (the sign-in next param): same event only.
    try {
      var rawLogin = root.getAttribute("data-login-url");
      if (typeof rawLogin === "string") {
        var marker = "?next=";
        var at = rawLogin.indexOf(marker);
        if (at !== -1) {
          var next = null;
          try {
            next = decodeURIComponent(rawLogin.slice(at + marker.length));
          } catch {
            next = null;
          }
          if (typeof next === "string" && next.charAt(0) === "/" && next.charAt(1) !== "/") {
            var qAt = next.indexOf("?");
            var nPath = qAt === -1 ? next : next.slice(0, qAt);
            var nSearch = qAt === -1 ? "" : next.slice(qAt);
            if (isSameEventPath(nPath)) return base + attendeesSuffix(nSearch);
          }
        }
      }
    } catch {
      // fall through to the bare event
    }
    return base;
  }
  var url = "/events/" + encodeURIComponent(eventKey) + "/rsvp";

  var controls = root.querySelector("[data-rsvp-form]") || root;
  var inflight = null;
  // Outcome focus belongs to the activation that started the write; the member's
  // outside focus or press ends it, and moving back into the widget does not revive it.
  var focusOwned = false;

  function releaseFocusOnOutsideInteraction(ev) {
    if (!focusOwned || !ev.target) return;
    // The contextual help link lives inside the widget but outside the
    // repainted form: landing on it ends outcome ownership like leaving the
    // widget, so settlement never steals focus from the reader.
    if (!root.contains(ev.target)) focusOwned = false;
    else if (ev.target.closest && ev.target.closest("[data-rsvp-help]")) focusOwned = false;
  }
  document.addEventListener("focusin", releaseFocusOnOutsideInteraction, true);
  document.addEventListener("pointerdown", releaseFocusOnOutsideInteraction, true);
  // Feedback deadline only: it cannot cancel or determine the server write.
  // Unknown outcomes stay locked until the member refreshes the SSR page.
  var FEEDBACK_DEADLINE_MS = 8000;

  function clearOutcome() {
    [
      TESTID.rateLimited,
      TESTID.failed,
      TESTID.sessionExpired,
      TESTID.closed,
      TESTID.waitlistSeatTaken,
      TESTID.syncing,
      TESTID.synced,
      TESTID.syncFailed,
    ].forEach(function (t) {
      var n = root.querySelector('[data-testid="' + t + '"]');
      if (n && n.parentNode) n.parentNode.removeChild(n);
      else if (n && n.remove) n.remove();
    });
  }

  function notice(testid, role, text, withLogin, shouldFocus, recoveryHref) {
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
      a.href = recoveryHref || loginUrl;
      a.textContent = COPY.guestCta;
      el.appendChild(a);
    }
    controls.appendChild(el);
    // Focus is opt-in (board-6956): failure/throttle notices never take
    // focus themselves — the alert announces, and the caller restores focus
    // to the re-enabled control. Only the session-expired notice moves
    // focus to the login path.
    if (shouldFocus === true && el.focus) el.focus();
    return el;
  }

  // SSR paints the full notice before the waitlist button; keep that DOM
  // order when the island paints (or re-paints) it, so Tab from the focused
  // notice reaches the button instead of leaving the widget.
  function placeBefore(el, anchor) {
    // Already in place: re-inserting would move the node and drop focus
    // from it (a capacity refresh can land right after a 409 focused it).
    if (anchor && el.nextSibling === anchor) return;
    if (anchor && anchor.parentNode && anchor.parentNode.insertBefore)
      anchor.parentNode.insertBefore(el, anchor);
    else controls.appendChild(el);
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
        if (!button.getAttribute("data-label"))
          button.setAttribute("data-label", button.textContent);
        button.textContent = busyText;
      } else if (!on && button.getAttribute("data-label")) {
        button.textContent = button.getAttribute("data-label");
        button.removeAttribute("data-label");
      }
    }
  }

  // A refused write keeps the same control, but setBusy disabled it while it
  // held focus and the browser dropped focus to BODY at that moment. Put
  // focus back on the re-enabled control — only while this activation still
  // owns outcome focus, so a member who moved on mid-write is left alone.
  function restoreFocus(button) {
    if (!focusOwned || !button || button.disabled || !root.contains(button)) return;
    if (button.focus) button.focus();
  }

  function focusTestid(testids) {
    if (!focusOwned) return false;
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
      '[data-testid="' +
        TESTID.syncing +
        '"],[data-testid="' +
        TESTID.synced +
        '"],[data-testid="' +
        TESTID.syncFailed +
        '"]',
    );
    if (old) {
      if (old.parentNode) old.parentNode.removeChild(old);
      else if (old.remove) old.remove();
    }
    var el = document.createElement("p");
    if (syncFailed) {
      // board-6990 syncing-vs-failed: the write held the spot but the Discord
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

  function removeSoft() {
    // A settled write supersedes the stored soft answer: the neutral line
    // goes with the source controls so a stale answer can never survive
    // beside the new state.
    [TESTID.maybe, TESTID.notGoing].forEach(function (t) {
      var n = root.querySelector('[data-testid="' + t + '"]');
      if (n && n.parentNode) n.parentNode.removeChild(n);
      else if (n && n.remove) n.remove();
    });
  }

  function paintConfirmed() {
    removeSoft();
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
      } catch {
        nodes = null;
      }
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
    // A settled place in line supersedes the full-event join invitation.
    removeSoft();
    [TESTID.going, TESTID.waitlistJoin, TESTID.confirmed, TESTID.withdraw, TESTID.full].forEach(
      function (t) {
        var n = root.querySelector('[data-testid="' + t + '"]');
        if (n && n.parentNode) n.parentNode.removeChild(n);
        else if (n && n.remove) n.remove();
      },
    );
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
    if (
      root.getAttribute("data-full") !== "true" &&
      root.getAttribute("data-paused") !== "true" &&
      !root.querySelector('[data-testid="' + TESTID.waitlistClaim + '"]')
    ) {
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

  function unknownOutcome(button) {
    setBusy(false, button);
    root.setAttribute("data-outcome-unknown", "true");
    root.querySelectorAll("[data-action]").forEach(function (control) {
      control.disabled = true;
    });
    // Recovery respects relinquished ownership: an outside focus/press during
    // the pending write leaves the member where they moved.
    var el = notice(TESTID.unknown, "alert", COPY.unknown, false, focusOwned);
    el.appendChild(document.createTextNode(" "));
    var link = document.createElement("a");
    link.setAttribute("data-testid", TESTID.refresh);
    link.href = safeRefreshHref();
    link.textContent = COPY.refresh;
    el.appendChild(link);
  }

  var pendingCapacity = null;

  function reconcileCapacity(detail) {
    if (detail.eventKey !== eventKey || root.getAttribute("data-outcome-unknown") === "true")
      return;
    // Seat-accurate verdict: occupancy counts every going row like the write
    // path; absent on older snapshots, where the attributable count stands in.
    var occupancy = detail.goingOccupancy === undefined ? detail.goingCount : detail.goingOccupancy;
    if (
      !Number.isSafeInteger(detail.goingCount) ||
      detail.goingCount < 0 ||
      !Number.isSafeInteger(occupancy) ||
      occupancy < 0 ||
      (detail.capacity !== null && (!Number.isSafeInteger(detail.capacity) || detail.capacity < 1))
    )
      return;
    // Accepted reads may settle during a later write. Keep only the latest
    // snapshot, without changing the controls or requested intent mid-flight.
    if (root.getAttribute("aria-busy") === "true") {
      pendingCapacity = {
        eventKey: eventKey,
        goingCount: detail.goingCount,
        goingOccupancy: occupancy,
        capacity: detail.capacity,
      };
      return;
    }
    pendingCapacity = null;
    var full = detail.capacity !== null && occupancy >= detail.capacity;
    root.setAttribute("data-full", full ? "true" : "false");
    if (detail.capacity === null) root.removeAttribute("data-capacity");
    else root.setAttribute("data-capacity", detail.capacity);
    if (root.getAttribute("data-paused") === "true") return;
    var join = root.querySelector(
      '[data-testid="' + TESTID.going + '"],[data-testid="' + TESTID.waitlistJoin + '"]',
    );
    var position = root.querySelector('[data-testid="' + TESTID.waitlistPosition + '"]');
    if (join) {
      join.setAttribute("data-testid", full ? TESTID.waitlistJoin : TESTID.going);
      join.setAttribute("data-action", full ? "waitlisted" : "going");
      join.setAttribute("value", full ? "waitlisted" : "going");
      join.textContent = full ? COPY.waitlistJoin : COPY.cta;
    }
    var claim = root.querySelector('[data-testid="' + TESTID.waitlistClaim + '"]');
    if (full && claim) claim.remove();
    if (!full && position && !claim) {
      claim = document.createElement("button");
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
    var message = root.querySelector('[data-testid="' + TESTID.full + '"]');
    // The soft branch deliberately omits the full notice at SSR (a soft
    // answer holds no seat); a capacity refresh must not paint what SSR
    // omits. The change control above still tracks capacity either way.
    var soft = root.querySelector(
      '[data-testid="' + TESTID.maybe + '"],[data-testid="' + TESTID.notGoing + '"]',
    );
    if (full && join && !soft) {
      if (!message) {
        message = document.createElement("p");
        message.setAttribute("role", "status");
        message.setAttribute("data-testid", TESTID.full);
      }
      placeBefore(message, join);
      message.textContent = COPY.full + " " + fullCapCopy(detail.capacity);
    } else if (message) message.remove();
  }

  document.addEventListener("going-count-refreshed", function (ev) {
    reconcileCapacity((ev && ev.detail) || {});
  });

  function paintWithdrawn() {
    // The soft line anchors the join-CTA replacement exactly like the
    // confirmed/position lines; the soft change control (a going- or
    // waitlist-testidd button) goes with the other source controls.
    var conf = root.querySelector(
      '[data-testid="' +
        TESTID.confirmed +
        '"],[data-testid="' +
        TESTID.waitlistPosition +
        '"],[data-testid="' +
        TESTID.maybe +
        '"],[data-testid="' +
        TESTID.notGoing +
        '"]',
    );
    [
      TESTID.going,
      TESTID.waitlistJoin,
      TESTID.waitlistClaim,
      TESTID.waitlistLeave,
      TESTID.withdraw,
      TESTID.syncing,
      TESTID.synced,
      TESTID.syncFailed,
    ].forEach(function (t) {
      var n = root.querySelector('[data-testid="' + t + '"]');
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
    // FIFO promotion can keep a withdrawn seat occupied. Preserve the last
    // known capacity until the badge's owned aggregate refresh settles.
    // Neither a withdrawal nor a refresh may reopen a paused event.
    if (root.getAttribute("data-paused") === "true") {
      if (conf && conf.parentNode) conf.parentNode.removeChild(conf);
      // No control may reopen a paused event, so the paused status is the
      // only deliberate landing spot: make it programmatically focusable at
      // settle time (SSR keeps it out of the tab order on browse) and move
      // focus there when this write still owns it, never leaving BODY.
      var paused = root.querySelector('[data-testid="' + TESTID.paused + '"]');
      if (paused) {
        if (!paused.getAttribute("tabindex")) paused.setAttribute("tabindex", "-1");
        focusTestid([TESTID.paused]);
      }
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
    join.addEventListener("click", function (ev) {
      onAction(join.getAttribute("data-action"), join, ev);
    });
    if (full) {
      var message = root.querySelector('[data-testid="' + TESTID.full + '"]');
      if (!message) {
        message = document.createElement("p");
        message.setAttribute("role", "status");
        message.setAttribute("data-testid", TESTID.full);
        var capRaw = root.getAttribute("data-capacity");
        var capNum = capRaw === null || capRaw === "" ? NaN : Number(capRaw);
        message.textContent =
          COPY.full + (Number.isFinite(capNum) ? " " + fullCapCopy(capNum) : "");
      }
      placeBefore(message, join);
    }
    focusTestid([TESTID.going, TESTID.waitlistJoin]);
  }

  function broadcast(state) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT, {
          detail: { eventKey: eventKey, viewerState: state },
          bubbles: true,
        }),
      );
    } catch {
      /* a missing CustomEvent is a missing badge listener, never a failed write */
    }
  }

  function retryAfterSeconds(res) {
    try {
      var h = res.headers && res.headers.get ? res.headers.get("Retry-After") : null;
      var n = Math.ceil(Number(h));
      return Number.isFinite(n) && n >= 1 ? n : null;
    } catch {
      return null;
    }
  }

  function sessionExpiredResponse(res) {
    if (!res) return false;
    if (res.status === 401 || res.status === 419) return true;
    try {
      if (res.type === "opaqueredirect" || res.status === 302) return true;
    } catch {}
    return false;
  }

  function onAction(action, button, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (inflight || root.getAttribute("data-outcome-unknown") === "true") return;
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
    focusOwned = true;
    var watchdog = setTimeout(function () {
      if (inflight !== controller) return;
      // Revoke write ownership before rendering recovery so late headers/body
      // and buffered capacity snapshots cannot guess or replace its outcome.
      inflight = null;
      unknownOutcome(button);
    }, FEEDBACK_DEADLINE_MS);
    // A waitlisted member clicking the claim control: if the locked server
    // keeps them waitlisted, a rival took the freed seat first.
    var claimingFromWaitlist =
      action === "going" && !!root.querySelector('[data-testid="' + TESTID.waitlistPosition + '"]');
    var isWithdraw = action === "withdraw";
    var method = isWithdraw ? "DELETE" : "PUT";
    setBusy(true, button, isWithdraw ? COPY.removing : COPY.saving);
    var init = {
      method: method,
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      redirect: "manual",
    };
    if (!isWithdraw) init.body = JSON.stringify({ status: action });
    fetch(url, init)
      .then(
        function (res) {
          if (controller && inflight !== controller) return;
          if (res.ok) {
            if (isWithdraw) {
              if (res.status !== 204) return unknownOutcome(button);
              setBusy(false, button);
              paintWithdrawn();
              broadcast(viewerState("withdraw"));
              return;
            }
            // A committed write with no readable answer is not a failed write
            // or a confirmed seat. Recover through SSR, never guess or resend.
            if ((res.status !== 200 && res.status !== 201) || typeof res.json !== "function") {
              return unknownOutcome(button);
            }
            try {
              return res.json().then(
                function (j) {
                  if (inflight !== controller) return;
                  var d = j && j.data;
                  if (!d || (d.status !== "going" && d.status !== "waitlisted"))
                    return unknownOutcome(button);
                  setBusy(false, button);
                  // The FIFO service may settle a going request as waitlisted.
                  if (d.status === "waitlisted") {
                    root.setAttribute("data-full", "true");
                    paintWaitlisted(d.waitlist_position);
                  } else {
                    paintConfirmed();
                  }
                  broadcast(viewerState(d.status));
                  if (claimingFromWaitlist && d.status === "waitlisted") {
                    // Lost the race: the place in line is unchanged, so say so
                    // politely (role=status, no focus move) instead of "Saved."
                    var note = notice(TESTID.waitlistSeatTaken, "status", "", false, false);
                    note.setAttribute("aria-live", "polite");
                    // Expose the empty region before a later task changes its content.
                    setTimeout(function () {
                      if (
                        root.querySelector('[data-testid="' + TESTID.waitlistSeatTaken + '"]') ===
                        note
                      )
                        note.textContent = COPY.waitlistSeatTaken;
                    }, 0);
                    return;
                  }
                  syncNote(d.synced_to_discord_at || null, !!d.sync_failed);
                },
                function () {
                  if (inflight === controller) unknownOutcome(button);
                },
              );
            } catch {
              return unknownOutcome(button);
            }
          }
          if (isWithdraw && res.status === 404) {
            // Converged withdraw: the row is already gone (second DELETE,
            // cross-tab double-withdraw, retry after a lost 204). Paint the
            // withdrawn end state like a 204, never the failure alert.
            setBusy(false, button);
            paintWithdrawn();
            broadcast(viewerState("withdraw"));
            return;
          }
          if (sessionExpiredResponse(res)) {
            controller.refused = true;
            var showExpired = function (data) {
              if (inflight !== controller) return;
              setBusy(false, button);
              notice(
                TESTID.sessionExpired,
                "alert",
                COPY.sessionExpired,
                true,
                focusOwned,
                safeRecoveryUrl(data && data.recovery),
              );
            };
            // Keep the same feedback deadline and ownership while reading the
            // refusal. Missing/unreadable bodies retain the guest join link.
            try {
              if (typeof res.json === "function")
                return res.json().then(showExpired, function () {
                  showExpired(null);
                });
            } catch {
              showExpired(null);
              return;
            }
            showExpired(null);
            return;
          }
          if (res.status === 429) {
            controller.refused = true;
            setBusy(false, button);
            notice(
              TESTID.rateLimited,
              "status",
              throttleWaitCopy(retryAfterSeconds(res)),
              false,
              false,
            );
            restoreFocus(button);
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
                      controller.refused = true;
                      setBusy(false, button);
                      notice(
                        TESTID.failed,
                        "alert",
                        COPY.failedTitle + " " + COPY.failedAction,
                        false,
                        false,
                      );
                      restoreFocus(button);
                    } else {
                      reloadClosed();
                    }
                  },
                  function () {
                    reloadClosed();
                  },
                );
              } catch {
                reloadClosed();
              }
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
              var position = root.querySelector('[data-testid="' + TESTID.waitlistPosition + '"]');
              // A soft answer holds no seat, so a raced fill flips its change
              // control without painting the full notice SSR omits — the same
              // rule as the capacity refresh.
              var soft = root.querySelector(
                '[data-testid="' + TESTID.maybe + '"],[data-testid="' + TESTID.notGoing + '"]',
              );
              var old = root.querySelector('[data-testid="' + TESTID.full + '"]');
              if (position || soft) {
                if (old) old.remove();
                old = null;
              } else {
                if (!old) {
                  old = document.createElement("p");
                  old.setAttribute("role", "status");
                  old.setAttribute("data-testid", TESTID.full);
                  old.setAttribute("tabindex", "-1");
                }
                old.textContent =
                  COPY.full + (Number.isFinite(capNum) ? " " + fullCapCopy(capNum) : "");
              }
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
              if (!position && old)
                placeBefore(
                  old,
                  going || root.querySelector('[data-testid="' + TESTID.waitlistJoin + '"]'),
                );
              if (position) focusTestid([TESTID.waitlistPosition]);
              else if (soft) {
                // No notice exists to take focus; the flipped change control
                // announces the fill itself when focused.
                var changed = root.querySelector('[data-testid="' + TESTID.waitlistJoin + '"]');
                if (focusOwned && changed && changed.focus) changed.focus();
              } else if (focusOwned && old && old.focus) old.focus();
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
                  function () {
                    paintFull(domNum);
                  },
                );
              } catch {
                paintFull(domNum);
              }
            } else {
              paintFull(domNum);
            }
            return;
          }
          controller.refused = res.status >= 400 && res.status < 500;
          setBusy(false, button);
          // Failure keeps the control enabled; the alert announces without
          // taking focus, and focus returns to the control it started on.
          notice(TESTID.failed, "alert", COPY.failedTitle + " " + COPY.failedAction, false, false);
          restoreFocus(button);
        },
        function () {
          if (controller && inflight !== controller) return;
          // No response cannot prove refusal or cancel a delivered transaction.
          unknownOutcome(button);
        },
      )
      .finally(function () {
        // Keep ownership through body parsing; header arrival is not completion.
        clearTimeout(watchdog);
        if (inflight === controller) {
          inflight = null;
          focusOwned = false;
          var snapshot = pendingCapacity;
          pendingCapacity = null;
          // Only a refused write can reuse the earlier accepted allocation.
          // Success owns a newer refresh; unknown/closed/full outcomes must not
          // be reopened by a pre-settlement snapshot.
          if (controller.refused && snapshot) reconcileCapacity(snapshot);
        }
      });
  }

  if (controls !== root)
    controls.addEventListener("submit", function (ev) {
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
