// PastEvents: SSR-first archive; page-turn reads only, never a polling loop.
//
// One owned read deadline (READ_DEADLINE_MS, at most 10 seconds) spans response
// headers plus HTML body settlement. On expiry the read is aborted where
// possible, busy/loading is released and accessible failure recovery is shown,
// even when abort is ignored. Late or superseded completions never commit
// content, history or metadata and never clear a newer read. No repeat read.
(function () {
  "use strict";
  var root = document.querySelector('[data-island="past-events"]');
  if (!root) return;
  var selectors = ["[data-archive-state]", "[data-archive-list]", "[data-archive-pager]"];
  var targets = selectors.map(function (s) {
    return root.querySelector(s);
  });
  var feedback = root.querySelector("[data-archive-feedback]");
  var heading = root.querySelector("h1");
  if (
    targets.some(function (n) {
      return !n;
    }) ||
    !feedback ||
    !heading
  )
    return;
  var active = null;
  var deadlineTimer = null;
  // Path and query of the rendered page; a fragment does not change the page.
  var renderedAddress = pageAddress(new URL(window.location.href));
  // Owned read deadline for one page turn: fetch plus response-body completion.
  // One shot per read, never a repeat; superseded timers are disarmed and an
  // obsolete timer that still fires cannot touch a newer read.
  var READ_DEADLINE_MS = 10000;

  // Finite HTML byte cap for one discovery read (mirrors
  // DISCOVERY_HTML_MAX_BYTES in src/islands/contracts-shared.ts). It counts
  // bytes consumed from the body stream, never Content-Length (advisory), and
  // cancels the stream on overflow, before DOMParser sees anything. A
  // body-less response falls back to text(): that only bounds the parse, not
  // the download, which the runtime has already buffered.
  var HTML_MAX_BYTES = 1048576;

  async function readHtml(response, signal) {
    var reader = response.body && response.body.getReader && response.body.getReader();
    var html = "";
    if (!reader || typeof TextDecoder === "undefined") {
      html = await response.text();
      // UTF-8 byte length: each %XX escape is one byte, every other char is ASCII.
      if (encodeURIComponent(html).replace(/%../g, "x").length > HTML_MAX_BYTES)
        throw new Error("HTML too large");
      return html;
    }
    var decoder = new TextDecoder();
    var total = 0;
    for (var step; !(step = await reader.read()).done; ) {
      total += step.value.byteLength;
      if (total > HTML_MAX_BYTES || signal.aborted) {
        reader.cancel().catch(function () {});
        throw signal.aborted
          ? new DOMException("Aborted", "AbortError")
          : new Error("HTML too large");
      }
      html += decoder.decode(step.value, { stream: true });
    }
    return html + decoder.decode();
  }
  // The deadline needs both timer globals; harnesses without a fake clock keep
  // the pre-deadline admission behavior.
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";

  function pageAddress(url) {
    return url.pathname + url.search;
  }

  function clearDeadline() {
    if (deadlineTimer !== null) {
      if (canTimeout) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  }

  function expire(controller, push) {
    // Only the current read owns failure recovery: a superseded timer that
    // fires during a newer read changes nothing.
    if (active !== controller) return;
    deadlineTimer = null;
    try {
      controller.abort();
    } catch {}
    active = null;
    // Release this read's focus tracking now: an abort-ignoring fetch or body
    // would otherwise keep the listener until its promise settles.
    controller.release();
    root.removeAttribute("aria-busy");
    feedback.textContent = root.dataset.loadError;
    // Same reconciliation as an ordinary failure: a click that never pushed its
    // target stays inline, a Back/forward read reloads the SSR document.
    if (!push || pageAddress(new URL(window.location.href)) !== renderedAddress)
      window.location.assign(window.location.href);
  }

  function archiveSearch(page, query) {
    var params = new URL("/events/past", window.location.href).searchParams;
    if (Number(page) > 1) params.set("page", String(page));
    if (query) params.set("q", query);
    var search = params.toString();
    return search ? "?" + search : "";
  }

  function archiveUrl(href, fromHistory) {
    var url = new URL(href, window.location.href);
    var params = url.searchParams;
    var valid = Array.from(params.keys()).every(function (key) {
      return (key === "page" || key === "q") && params.getAll(key).length === 1;
    });
    var page = params.get("page");
    return url.origin === window.location.origin &&
      url.pathname === "/events/past" &&
      (fromHistory || (valid && (!page || /^[1-9]\d*$/.test(page)) && !url.hash))
      ? url
      : null;
  }

  function required(parent, selector) {
    var nodes = parent.querySelectorAll(selector);
    if (nodes.length !== 1) throw new Error("Invalid archive page");
    return nodes[0];
  }

  function zones(parent) {
    var nodes = selectors.map(function (s) {
      return required(parent, s);
    });
    if (
      nodes.some(function (node, i) {
        return nodes.some(function (other, j) {
          return i !== j && node.contains(other);
        });
      })
    )
      throw new Error("Invalid archive page");
    return nodes;
  }

  function metadata(page) {
    var canonical = required(page, 'link[rel="canonical"]');
    var og = required(page, 'meta[property="og:url"]');
    var href = canonical.getAttribute("href");
    var content = og.getAttribute("content");
    var url = href && archiveUrl(href);
    if (!url || !content || new URL(content, window.location.href).href !== url.href) {
      throw new Error("Invalid archive page");
    }
    return { canonical: canonical, og: og, href: url.href };
  }

  async function load(url, push) {
    if (active) {
      // Supersession: abort the old read and drop its focus tracking at once.
      active.abort();
      active.release();
    }
    clearDeadline();
    var controller = new AbortController();
    // Back/forward reads must not be skipped by the fragment-only popstate rule.
    controller.fromHistory = !push;
    active = controller;
    // Focus ownership: an uninterrupted page turn lands on the archive heading,
    // but a member who deliberately tabs to a stable header/footer control while
    // the read is pending keeps that control. Any focusin to another target
    // marks movement, so moving away and back is remembered explicitly rather
    // than guessed from the final active element.
    var focusAtStart = document.activeElement;
    var focusMoved = false;
    var trackFocus = function (event) {
      if (event && event.target !== focusAtStart) focusMoved = true;
    };
    document.addEventListener("focusin", trackFocus);
    // One idempotent, per-read cleanup: success, failure, timeout and
    // supersession all call it, and it only ever removes this read's listener.
    var released = false;
    controller.release = function () {
      if (released) return;
      released = true;
      document.removeEventListener("focusin", trackFocus);
    };
    root.setAttribute("aria-busy", "true");
    feedback.textContent = "Loading past events…";
    // The owned deadline covers the whole read: headers plus body. On expiry
    // the read no longer owns content, history or metadata — late completions
    // are dropped by the active guard. No automatic repeat read.
    if (canTimeout) {
      deadlineTimer = setTimeout(function () {
        expire(controller, push);
      }, READ_DEADLINE_MS);
    }
    try {
      var response = await fetch(url.pathname + url.search, {
        method: "GET",
        headers: { accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Archive unavailable");
      var html = await readHtml(response, controller.signal);
      if (active !== controller || controller.signal.aborted) return;
      var page = new DOMParser().parseFromString(html, "text/html");
      var next = required(page, '[data-island="past-events"]');
      var sources = zones(next);
      var incoming = metadata(page);
      var live = metadata(document);
      var current = zones(root);
      if (
        required(document, '[data-island="past-events"]') !== root ||
        current.some(function (node, i) {
          return node !== targets[i];
        }) ||
        required(root, "h1") !== heading ||
        required(root, "[data-archive-feedback]") !== feedback ||
        current.some(function (node) {
          return (
            node.contains(heading) ||
            node.contains(feedback) ||
            node.contains(live.canonical) ||
            node.contains(live.og)
          );
        }) ||
        sources.some(function (node) {
          return node.contains(incoming.canonical) || node.contains(incoming.og);
        })
      ) {
        throw new Error("Invalid archive page");
      }
      var pageNumber = next.dataset.page;
      var totalPages = next.dataset.totalPages;
      var query = next.dataset.query || "";
      if (
        !/^[1-9]\d*$/.test(pageNumber) ||
        !/^(0|[1-9]\d*)$/.test(totalPages) ||
        !Number.isSafeInteger(Number(pageNumber)) ||
        !Number.isSafeInteger(Number(totalPages)) ||
        new URL(incoming.href).search !== archiveSearch(pageNumber, query)
      ) {
        throw new Error("Invalid archive page");
      }
      // Resolve and import everything before the first last-good DOM mutation.
      var swaps = sources.map(function (source, i) {
        return {
          target: targets[i],
          hidden: source.hidden,
          children: Array.from(source.childNodes).map(function (n) {
            return document.importNode(n, true);
          }),
        };
      });
      if (active !== controller || controller.signal.aborted) return;
      // Decide focus before the swap detaches the activating pager link: an
      // uninterrupted turn owns focus and lands on the heading, while deliberate
      // movement preserves the member's control unless it lives inside a zone
      // about to be replaced (then the heading avoids a body fallback).
      var currentFocus = document.activeElement;
      var ownsFocus = !focusMoved && currentFocus === focusAtStart;
      var focusInsideSwap =
        !!currentFocus &&
        targets.some(function (target) {
          return target.contains(currentFocus);
        });
      swaps.forEach(function (swap) {
        swap.target.replaceChildren.apply(swap.target, swap.children);
        swap.target.hidden = swap.hidden;
      });
      root.dataset.page = pageNumber;
      root.dataset.totalPages = totalPages;
      root.dataset.query = query;
      live.canonical.href = incoming.href;
      live.og.content = incoming.href;
      if (push) window.history.pushState(null, "", url.pathname + url.search);
      renderedAddress = pageAddress(url);
      feedback.textContent = "";
      if (ownsFocus || focusInsideSwap) heading.focus();
    } catch (error) {
      if (active !== controller || error.name === "AbortError") return;
      feedback.textContent = root.dataset.loadError;
      // A click may have aborted a Back/forward read after the address changed.
      if (!push || pageAddress(new URL(window.location.href)) !== renderedAddress)
        window.location.assign(window.location.href);
    } finally {
      controller.release();
      // Settlement owns the deadline only while still current: an expired or
      // superseded read has already released both, and a newer read owns them.
      if (active === controller) {
        clearDeadline();
        root.removeAttribute("aria-busy");
        active = null;
      }
    }
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
    var link = event.target.closest("a[data-archive-page]");
    if (
      !link ||
      !root.contains(link) ||
      link.hasAttribute("download") ||
      (link.target && link.target !== "_self")
    )
      return;
    var url = archiveUrl(link.href);
    if (!url) return;
    event.preventDefault();
    load(url, true);
  });
  window.addEventListener("popstate", function () {
    // Entry URLs may include tracking parameters, noncanonical pages or fragments.
    var url = archiveUrl(window.location.href, true);
    // A fragment-only navigation (the skip link to #main) also fires popstate
    // with the rendered path and query: nothing to restore, so no request.
    // An in-flight Back/forward read still owns the zones and must be replaced.
    if (url && pageAddress(url) === renderedAddress && !(active && active.fromHistory)) return;
    if (url) load(url, false);
    else window.location.assign(window.location.href);
  });
})();
