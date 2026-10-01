// EventsCalendar: member-driven fragment re-renders (view toggle, month steps,
// settled search, past drawer, retry, grid day jumps). One fetch in flight —
// a newer action aborts the older. Skeleton + content swap on member-started
// actions only; typing in the search box is deliberately untargeted so the
// input never loses focus. Every control is a real anchor or a GET form, so
// the whole surface works without this file.
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
  if (zones.length === 0 || !skeleton || !feedback || !input || !form || live.some(function (n) { return !n; })) return;

  var DEBOUNCE_MS = 300;
  var active = null;
  var activeIsSearch = false;
  var debounceTimer = null;
  // Back changes the address before its fetch commits. Replacing that request
  // must not lose the obligation to reconcile the address with the rendered page.
  var renderedAddress = pageAddress(new URL(window.location.href));

  function pageAddress(url) {
    return url.pathname + url.search;
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

  // opts.focus: a selector to focus after the swap (grid day jumps land on the card).
  // opts.skeleton: member-started actions show it; a settled search does not.
  // opts.syncInput: explicit navigation rewrites the box unless newer typing began.
  // opts.search: newer input invalidates this request before its debounce fires.
  async function load(url, push, opts) {
    opts = opts || {};
    var inputAtStart = input.value;
    if (active) active.abort();
    var controller = new AbortController();
    active = controller;
    activeIsSearch = !!opts.search;
    setLoading(!!opts.skeleton);
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
        sources.some(function (s) { return s.getAttribute("data-cal-zone") === null; })
      ) {
        throw new Error("Invalid calendar page");
      }
      // Admit every expected name exactly once before touching the live zones.
      var byName = new Map();
      sources.forEach(function (source) {
        var name = source.getAttribute("data-cal-zone");
        if (byName.has(name)) throw new Error("Invalid calendar page");
        byName.set(name, source);
      });
      var swaps = zones.map(function (target) {
        var name = target.getAttribute("data-cal-zone");
        var source = byName.get(name);
        if (!source) throw new Error("Invalid calendar page");
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
      root.dataset.view = next.dataset.view;
      root.dataset.month = next.dataset.month;
      root.dataset.past = next.dataset.past;
      live.forEach(function (node, i) {
        var source = page.querySelector('[data-testid="' + LIVE_TESTIDS[i] + '"]');
        if (source) node.textContent = source.textContent;
      });
      if (opts.syncInput && input.value === inputAtStart) {
        var sourceInput = page.querySelector('[data-testid="events-search"]');
        if (sourceInput) input.value = sourceInput.getAttribute("value") || "";
      }
      var canonicalLink = document.querySelector('link[rel="canonical"]');
      var ogUrl = document.querySelector('meta[property="og:url"]');
      if (canonicalLink) canonicalLink.href = canonical.href;
      if (ogUrl) ogUrl.content = canonical.href;
      if (push) window.history.pushState(null, "", url.pathname + url.search + url.hash);
      renderedAddress = pageAddress(url);
      feedback.textContent = "";
      if (opts.focus) {
        var target = root.querySelector(opts.focus);
        if (target) target.focus();
      }
    } catch (error) {
      if (active !== controller || error.name === "AbortError") return;
      feedback.textContent = root.dataset.loadError;
      // Preserve last-good content for ordinary failed actions. If Back/forward
      // changed the address (even before a superseding push), SSR restores it.
      if (!push || renderedAddress !== pageAddress(new URL(window.location.href))) {
        window.location.assign(window.location.href);
      }
    } finally {
      if (active === controller) {
        setLoading(false);
        active = null;
        activeIsSearch = false;
      }
    }
  }

  // The URL for a settled search: the raw input value (blank means no search),
  // the drawer stays as it was, and the search forces the list view — so
  // view/month params are dropped, matching the server's calendarUrl().
  function searchUrl(value) {
    var url = new URL("/events", window.location.origin);
    if (value.trim() !== "") url.searchParams.set("q", value);
    if (new URL(window.location.href).searchParams.get("past") === "1") {
      url.searchParams.set("past", "1");
    }
    return url;
  }

  root.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest("a");
    if (!link || !root.contains(link) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    cancelDebounce();

    // Grid day jump: re-render as the list, then move focus onto the card.
    if (link.hasAttribute("data-cal-jump")) {
      var hash = link.hash;
      var url = calendarHref(link.href);
      if (!url) return;
      event.preventDefault();
      load(url, true, { skeleton: true, syncInput: true, focus: hash || null });
      return;
    }

    var target = calendarHref(link.href);
    if (!target) return;
    event.preventDefault();
    load(target, true, { skeleton: true, syncInput: true });
  });

  input.addEventListener("input", function () {
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
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      load(searchUrl(input.value), true, { search: true });
    }, DEBOUNCE_MS);
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    cancelDebounce();
    load(searchUrl(input.value), true, { search: true });
  });

  window.addEventListener("popstate", function () {
    cancelDebounce();
    var url = calendarHref(window.location.href);
    if (url) load(url, false, { skeleton: true, syncInput: true });
  });
})();
