// EventsCalendar: member-driven fragment re-renders (view toggle, month steps,
// month jump, settled search, past drawer, retry, grid day jumps). One fetch
// in flight — a newer action aborts the older. Skeleton + content swap on
// member-started actions only; typing in the search box is deliberately
// untargeted so the input never loses focus. Every control is a real anchor
// or a GET form, so the whole surface works without this file.
(function () {
  "use strict";
  var root = document.querySelector('[data-island="events-calendar"]');
  if (!root) return;

  var ZONE_SELECTOR = "[data-cal-zone]";
  var zones = Array.from(root.querySelectorAll(ZONE_SELECTOR));
  var skeleton = root.querySelector('[data-testid="events-loading"]');
  var feedback = root.querySelector("[data-cal-feedback]");
  var input = root.querySelector('[data-testid="events-search"]');
  var form = input && input.closest("form");
  var LIVE_TESTIDS = [
    "events-view-status",
    "events-search-status",
    "events-past-status",
    "calendar-month-status",
  ];
  var live = LIVE_TESTIDS.map(function (t) {
    return root.querySelector('[data-testid="' + t + '"]');
  });
  if (
    zones.length === 0 ||
    !skeleton ||
    !feedback ||
    !input ||
    !form ||
    live.some(function (n) {
      return !n;
    })
  )
    return;

  var DEBOUNCE_MS = 300;
  var searchMaxLength = Number(root.dataset.searchMaxLength);
  var searchTooLong = root.dataset.searchTooLong;
  // Owned overall read deadline: fetch headers plus response-body completion,
  // at most 10 seconds (mirrors EVENTS_CALENDAR_READ_DEADLINE_MS in
  // src/islands/contracts-calendar.ts). On expiry the owned request is
  // abandoned: the last good zones stay intact, loading/aria-busy releases,
  // and failure feedback shows without committing the timed-out URL,
  // canonical state or response fragment. A superseded request's timer stays
  // silent and cannot clear the newer owner's loading state.
  var READ_DEADLINE_MS = 10000;
  var active = null;
  var activeIsSearch = false;
  var debounceTimer = null;
  var inputRevision = 0;
  // The deadline needs both timer globals; harnesses with a partial fake
  // clock (setTimeout only) get the pre-deadline behavior.
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";
  // Back changes the address before its fetch commits. Replacing that request
  // must not lose the obligation to reconcile the address with the rendered page.
  var renderedAddress = pageAddress(new URL(window.location.href));

  function pageAddress(url) {
    return url.pathname + url.search;
  }

  function invalidPage() {
    throw new Error("Invalid calendar page");
  }

  function cancelDebounce() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Same-origin /events only: view, month, q, past params are the island's
  // vocabulary. Anything else (archive link, sign-in, card links) is a real
  // navigation and passes through.
  function calendarHref(href) {
    var url;
    try {
      url = new URL(href, window.location.href);
    } catch (e) {
      return null;
    }
    return url.origin === window.location.origin && url.pathname === "/events" ? url : null;
  }

  function setLoading(on) {
    skeleton.hidden = !on;
    var content = root.querySelector('[data-cal-zone="content"]');
    if (content) content.hidden = on;
    root.setAttribute("aria-busy", on ? "true" : "false");
    if (!on) root.removeAttribute("aria-busy");
  }

  // URLs change across month steps; the control's test ID or label is stable.
  function replacementControl(control) {
    if (root.contains(control) && !control.closest("[hidden]")) return control;
    var attr = control.hasAttribute("data-testid") ? "data-testid" : "aria-label";
    var identity = control.getAttribute(attr);
    if (!identity) return null;
    return (
      Array.from(root.querySelectorAll("a")).find(function (link) {
        return (
          link.getAttribute(attr) === identity &&
          calendarHref(link.href) &&
          !link.closest("[hidden]")
        );
      }) || null
    );
  }

  // Failed navigation keeps every last-good zone intact, so the initiating
  // control survives — but hiding the content zone may already have blurred
  // its keyboard origin to body. When this request still owns keyboard focus
  // (focus never moved, no newer input, and any body blur came from hiding
  // its own content-zone origin), reveal the last-good view first and restore
  // that control with the same resolution successful swaps use. Pointer
  // activation carries no control and never restores.
  function restoreFailedFocus(opts, focusAtStart, focusMoved, inputRevisionAtStart) {
    if (!opts.control || !focusAtStart || focusMoved || inputRevision !== inputRevisionAtStart)
      return;
    var blurred =
      document.activeElement === focusAtStart ||
      (opts.skeleton &&
        root.contains(focusAtStart) &&
        focusAtStart.closest('[data-cal-zone="content"]') &&
        document.activeElement === document.body);
    if (!blurred) return;
    // A hidden control cannot take focus: reveal before resolving, so the
    // surviving origin resolves to itself rather than the heading fallback.
    setLoading(false);
    var target = (opts.focus && root.querySelector(opts.focus)) || null;
    if (!target) target = replacementControl(opts.control) || root.querySelector("#events-heading");
    if (target) target.focus();
  }

  // opts.control: the focused keyboard-activated anchor to restore if replaced.
  // opts.focus: a selector to focus after the swap (grid day jumps land on the card).
  // opts.skeleton: member-started actions show it; a settled search does not.
  // opts.syncInput: explicit navigation rewrites the box unless newer typing began.
  // opts.search: newer input invalidates this request before its debounce fires.
  async function load(url, push, opts) {
    opts = opts || {};
    var inputAtStart = input.value;
    var inputRevisionAtStart = inputRevision;
    var focusAtStart = document.activeElement;
    if (active) active.abort();
    var controller = new AbortController();
    // Back/forward reads must not be skipped by the fragment-only popstate rule.
    controller.fromHistory = !push;
    active = controller;
    var focusMoved = false;
    var trackFocus =
      focusAtStart && (opts.focus || opts.control)
        ? function (event) {
            if (event.target !== focusAtStart) focusMoved = true;
          }
        : null;
    if (trackFocus) document.addEventListener("focusin", trackFocus, { signal: controller.signal });
    activeIsSearch = !!opts.search;
    setLoading(!!opts.skeleton);
    // The owned deadline covers the whole read: headers plus body. On expiry
    // this request no longer owns the zones: release active first so its late
    // abort/completion stays silent, then restore the last good view.
    var deadlineTimer = null;
    if (canTimeout) {
      deadlineTimer = setTimeout(function () {
        if (active !== controller) return;
        deadlineTimer = null;
        active = null;
        activeIsSearch = false;
        try {
          controller.abort();
        } catch (e) {}
        if (trackFocus) document.removeEventListener("focusin", trackFocus);
        // Zones are untouched: the last good content is still in place, only
        // hidden by loading. No history, canonical or fragment commit. Keep
        // the Back/forward reconcile the catch path performs: popstate commits
        // the address before the read, so a timed-out Back (or a push that
        // superseded one) reloads for SSR to restore the matching page.
        feedback.textContent = root.dataset.loadError;
        setLoading(false);
        if (!push || renderedAddress !== pageAddress(new URL(window.location.href))) {
          window.location.assign(window.location.href);
        } else {
          restoreFailedFocus(opts, focusAtStart, focusMoved, inputRevisionAtStart);
        }
      }, READ_DEADLINE_MS);
    }
    try {
      var response = await fetch(url.pathname + url.search, {
        method: "GET",
        headers: { accept: "text/html", "x-two-island": "events-calendar" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Calendar unavailable");
      var html = await response.text();
      if (active !== controller) return;
      var page = new DOMParser().parseFromString(html, "text/html");
      var next = page.querySelector('[data-island="events-calendar"]');
      var sources = next && Array.from(next.querySelectorAll(ZONE_SELECTOR));
      var canonical = page.querySelector('link[rel="canonical"]');
      if (
        !sources ||
        sources.length !== zones.length ||
        !canonical ||
        sources.some(function (s) {
          return s.getAttribute("data-cal-zone") === null;
        })
      ) {
        invalidPage();
      }
      // Admit authentication destinations with the zones, never from a draft.
      // Require rooted, endpoint-specific links whose sole next is this request;
      // keep the complete href so attribution parameters survive unchanged.
      if (!calendarHref(canonical.href)) invalidPage();
      function authHref(source, endpoint) {
        var href = source.getAttribute("href");
        var returns = new URL(href, window.location.href).searchParams.getAll("next");
        if (
          !href ||
          !href.startsWith(endpoint + "?") ||
          returns.length !== 1 ||
          returns[0] !== pageAddress(url)
        )
          invalidPage();
        return href;
      }
      var authSwaps = [
        ['header a[data-testid="signin"]', "/auth/discord"],
        [".schedule-heading a", "/join"],
      ].map(function (entry) {
        var target = document.querySelector(entry[0]);
        var source = page.querySelector(entry[0]);
        if (!!target !== !!source) invalidPage();
        return { target: target, href: source && authHref(source, entry[1]) };
      });
      Array.from(next.querySelectorAll('a[data-testid="signin"]')).forEach(function (source) {
        authHref(source, "/join/discord");
      });
      // Check ownership before replacement detaches the focused control. Newer
      // typing (even back to the same value) or moved focus cancels restoration.
      // Hiding content can itself blur its control to body after a paint.
      var hiddenOrigin =
        focusAtStart &&
        root.contains(focusAtStart) &&
        focusAtStart.closest('[data-cal-zone="content"]');
      var skeletonBlur = opts.skeleton && hiddenOrigin && document.activeElement === document.body;
      var ownsFocus =
        !focusMoved &&
        inputRevision === inputRevisionAtStart &&
        (document.activeElement === focusAtStart || skeletonBlur);
      // Admit every expected name exactly once before touching the live zones.
      var byName = new Map();
      sources.forEach(function (source) {
        var name = source.getAttribute("data-cal-zone");
        if (byName.has(name)) invalidPage();
        byName.set(name, source);
      });
      var swaps = zones.map(function (target) {
        var name = target.getAttribute("data-cal-zone");
        var source = byName.get(name);
        if (!source) invalidPage();
        byName.delete(name);
        return { target: target, source: source };
      });
      // Import failures must also leave every last-good zone intact.
      swaps.forEach(function (swap) {
        swap.children = Array.from(swap.source.childNodes).map(function (node) {
          return document.importNode(node, true);
        });
      });
      swaps.forEach(function (swap) {
        swap.target.replaceChildren.apply(swap.target, swap.children);
        swap.target.hidden = swap.source.hidden;
      });
      authSwaps.forEach(function (swap) {
        if (swap.target) swap.target.setAttribute("href", swap.href);
      });
      // A swap replaces the month-jump form with a fresh node: rewire it so
      // the next submit re-enters the fragment flow. A no-op when the zones
      // carry no form (e.g. the list view) or the node is already wired.
      wireJumpForm();
      root.dataset.view = next.dataset.view;
      root.dataset.month = next.dataset.month;
      root.dataset.past = next.dataset.past;
      live.forEach(function (node, i) {
        var source = page.querySelector('[data-testid="' + LIVE_TESTIDS[i] + '"]');
        if (source) node.textContent = source.textContent;
      });
      if (
        opts.syncInput &&
        input.value === inputAtStart &&
        inputRevision === inputRevisionAtStart
      ) {
        var sourceInput = page.querySelector('[data-testid="events-search"]');
        if (sourceInput) input.value = sourceInput.getAttribute("value") || "";
      }
      var canonicalLink = document.querySelector('link[rel="canonical"]');
      var ogUrl = document.querySelector('meta[property="og:url"]');
      if (canonicalLink) canonicalLink.href = canonical.href;
      if (ogUrl) ogUrl.content = canonical.href;
      if (push) window.history.pushState(null, "", url.pathname + url.search + url.hash);
      renderedAddress = pageAddress(url);
      // A navigation that commits while the box is still over the limit keeps naming it.
      feedback.textContent = overLimit() ? searchTooLong : "";
      // A card or month control cannot take focus while content is hidden.
      setLoading(false);
      if (ownsFocus && (opts.focus || opts.control)) {
        var target = opts.focus && root.querySelector(opts.focus);
        if (!target && opts.control)
          target = replacementControl(opts.control) || root.querySelector("#events-heading");
        if (target) target.focus();
      }
    } catch (error) {
      if (active !== controller || error.name === "AbortError") return;
      feedback.textContent = root.dataset.loadError;
      // Preserve last-good content for ordinary failed actions. If Back/forward
      // changed the address (even before a superseding push), SSR restores it.
      if (!push || renderedAddress !== pageAddress(new URL(window.location.href))) {
        window.location.assign(window.location.href);
      } else {
        restoreFailedFocus(opts, focusAtStart, focusMoved, inputRevisionAtStart);
      }
    } finally {
      if (trackFocus) document.removeEventListener("focusin", trackFocus);
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (active === controller) {
        setLoading(false);
        active = null;
        activeIsSearch = false;
      }
    }
  }

  // The URL for a settled search: the raw input value (blank means no search),
  // the drawer stays as it was, the game facet rides along, and the search
  // forces the list view — so view/month params are dropped, matching the
  // server's calendarUrl(). The facet reads the live select (like the input
  // reads its live value), falling back to the address bar where the form
  // has no select yet.
  function searchUrl(value) {
    var url = new URL("/events", window.location.origin);
    if (value.trim() !== "") url.searchParams.set("q", value);
    var current = new URL(window.location.href).searchParams;
    if (current.get("past") === "1") {
      url.searchParams.set("past", "1");
    }
    var gameField = root.querySelector('select[name="game"]');
    var game = gameField ? gameField.value : current.get("game");
    if (game !== null && game !== undefined && String(game).trim() !== "") {
      url.searchParams.set("game", String(game).trim());
    }
    return url;
  }

  // The server counts code points; over-limit input is named here, never fetched.
  function overLimit() {
    return Array.from(input.value).length > searchMaxLength;
  }

  function runSearch() {
    if (overLimit()) {
      feedback.textContent = searchTooLong;
      return;
    }
    load(searchUrl(input.value), true, { search: true });
  }

  root.addEventListener("click", function (event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    var link = event.target.closest("a");
    if (
      !link ||
      !root.contains(link) ||
      link.hasAttribute("download") ||
      (link.target && link.target !== "_self")
    )
      return;
    cancelDebounce();
    var control = event.detail === 0 && document.activeElement === link ? link : null;

    // Grid day jump: re-render as the list, then move focus onto the card.
    if (link.hasAttribute("data-cal-jump")) {
      var hash = link.hash;
      var url = calendarHref(link.href);
      if (!url) return;
      event.preventDefault();
      load(url, true, { skeleton: true, syncInput: true, focus: hash || null, control: control });
      return;
    }

    var target = calendarHref(link.href);
    if (!target) return;
    event.preventDefault();
    load(target, true, { skeleton: true, syncInput: true, control: control });
  });

  // IME composition: partial text is not a query. While composing, typing still
  // supersedes an active search but schedules nothing; compositionend schedules
  // the single search from the committed value (a trailing input event only
  // reschedules that same timer, so it cannot double-submit).
  var composing = false;

  function scheduleSearch() {
    inputRevision += 1;
    cancelDebounce();
    // Typing supersedes a search immediately, not just when the next fetch starts.
    // Explicit navigation may still commit while newer text remains in the box.
    if (active && activeIsSearch) {
      active.abort();
      active = null;
      activeIsSearch = false;
      // Revoked owners cannot release loading inherited from navigation in finally.
      setLoading(false);
    }
    if (composing) return;
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      runSearch();
    }, DEBOUNCE_MS);
  }

  input.addEventListener("compositionstart", function () {
    composing = true;
    scheduleSearch();
  });

  input.addEventListener("compositionend", function () {
    composing = false;
    scheduleSearch();
  });

  input.addEventListener("input", function (event) {
    if (event && event.isComposing) composing = true;
    scheduleSearch();
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    cancelDebounce();
    if (composing || (event && event.isComposing)) return;
    runSearch();
  });

  // The month-jump form is a native GET form (view + past ride as hidden
  // fields), so a jump works without this file. With it, submit reuses the
  // fragment flow: the chosen month commits exactly like a month step, focus
  // landing in the new form — or back on the origin submitter on failure.
  // Typing in the month box schedules nothing: only submit navigates.
  var JUMP_FORM_SELECTOR = '[data-testid="calendar-month-jump"]';
  var JUMP_SUBMIT_SELECTOR = '[data-testid="calendar-month-jump-submit"]';
  var wiredJumpForm = null;

  function jumpUrl(formEl) {
    var url = new URL("/events", window.location.origin);
    url.searchParams.set("view", "calendar");
    ["month", "past"].forEach(function (name) {
      var field = formEl.querySelector('[name="' + name + '"]');
      if (field && field.value) url.searchParams.set(name, field.value);
    });
    return url;
  }

  function wireJumpForm() {
    var formEl = root.querySelector(JUMP_FORM_SELECTOR);
    if (!formEl || formEl === wiredJumpForm) return;
    wiredJumpForm = formEl;
    formEl.addEventListener("submit", function (event) {
      event.preventDefault();
      cancelDebounce();
      var submitter = (event && event.submitter) || formEl.querySelector(JUMP_SUBMIT_SELECTOR);
      var control = submitter && formEl.contains(document.activeElement) ? submitter : null;
      load(jumpUrl(formEl), true, {
        skeleton: true,
        syncInput: true,
        control: control,
        focus: JUMP_SUBMIT_SELECTOR,
      });
    });
  }

  window.addEventListener("popstate", function () {
    var url = calendarHref(window.location.href);
    // A fragment-only navigation (the skip link to #main) also fires popstate.
    // It leaves path and query on the rendered page, so there is nothing to
    // restore: no request, no skeleton, no touch to the box or its debounce.
    // An in-flight Back/forward read still owns the zones and must be replaced.
    if (url && pageAddress(url) === renderedAddress && !(active && active.fromHistory)) return;
    cancelDebounce();
    if (url) load(url, false, { skeleton: true, syncInput: true });
  });

  wireJumpForm();
})();
