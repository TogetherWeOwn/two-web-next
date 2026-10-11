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
  var renderedUrl = window.location.href;
  // Owned read deadline for one page turn: fetch plus response-body completion.
  // One shot per read, never a repeat; superseded timers are disarmed and an
  // obsolete timer that still fires cannot touch a newer read.
  var READ_DEADLINE_MS = 10000;
  // The deadline needs both timer globals; harnesses without a fake clock keep
  // the pre-deadline admission behavior.
  var canTimeout = typeof setTimeout !== "undefined" && typeof clearTimeout !== "undefined";

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
    root.removeAttribute("aria-busy");
    feedback.textContent = root.dataset.loadError;
    // Same reconciliation as an ordinary failure: a click that never pushed its
    // target stays inline, a Back/forward read reloads the SSR document.
    if (!push || window.location.href !== renderedUrl) window.location.assign(window.location.href);
  }

  function archiveUrl(href, fromHistory) {
    var url = new URL(href, window.location.href);
    return url.origin === window.location.origin &&
      url.pathname === "/events/past" &&
      (fromHistory || (/^(\?page=[1-9]\d*)?$/.test(url.search) && !url.hash))
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
    if (active) active.abort();
    clearDeadline();
    var controller = new AbortController();
    active = controller;
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
      var html = await response.text();
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
      if (
        !/^[1-9]\d*$/.test(pageNumber) ||
        !/^(0|[1-9]\d*)$/.test(totalPages) ||
        !Number.isSafeInteger(Number(pageNumber)) ||
        !Number.isSafeInteger(Number(totalPages)) ||
        new URL(incoming.href).search !== (pageNumber === "1" ? "" : "?page=" + pageNumber)
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
      swaps.forEach(function (swap) {
        swap.target.replaceChildren.apply(swap.target, swap.children);
        swap.target.hidden = swap.hidden;
      });
      root.dataset.page = pageNumber;
      root.dataset.totalPages = totalPages;
      live.canonical.href = incoming.href;
      live.og.content = incoming.href;
      if (push) window.history.pushState(null, "", url.pathname + url.search);
      renderedUrl = url.href;
      feedback.textContent = "";
      heading.focus();
    } catch (error) {
      if (active !== controller || error.name === "AbortError") return;
      feedback.textContent = root.dataset.loadError;
      // A click may have aborted a Back/forward read after the address changed.
      if (!push || window.location.href !== renderedUrl)
        window.location.assign(window.location.href);
    } finally {
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
    if (url) load(url, false);
    else window.location.assign(window.location.href);
  });
})();
