// PastEvents: SSR-first archive; page-turn reads only, never a polling loop.
(function () {
  "use strict";
  var root = document.querySelector('[data-island="past-events"]');
  if (!root) return;
  var selectors = ["[data-archive-state]", "[data-archive-list]", "[data-archive-pager]"];
  var targets = selectors.map(function (s) { return root.querySelector(s); });
  var feedback = root.querySelector("[data-archive-feedback]");
  var heading = root.querySelector("h1");
  if (targets.some(function (n) { return !n; }) || !feedback || !heading) return;
  var active = null;
  var renderedUrl = window.location.href;

  function archiveUrl(href, fromHistory) {
    var url = new URL(href, window.location.href);
    return url.origin === window.location.origin && url.pathname === "/events/past" &&
      (fromHistory || (/^(\?page=[1-9]\d*)?$/.test(url.search) && !url.hash)) ? url : null;
  }

  async function load(url, push) {
    if (active) active.abort();
    var controller = new AbortController();
    active = controller;
    root.setAttribute("aria-busy", "true");
    feedback.textContent = "Loading past events…";
    try {
      var response = await fetch(url.pathname + url.search, {
        method: "GET", headers: { accept: "text/html" }, signal: controller.signal
      });
      if (!response.ok) throw new Error("Archive unavailable");
      var html = await response.text();
      if (active !== controller) return;
      var page = new DOMParser().parseFromString(html, "text/html");
      var next = page.querySelector('[data-island="past-events"]');
      var sources = next && selectors.map(function (s) { return next.querySelector(s); });
      var canonical = page.querySelector('link[rel="canonical"]');
      if (!sources || sources.some(function (n) { return !n; }) || !canonical) throw new Error("Invalid archive page");
      sources.forEach(function (source, i) {
        targets[i].replaceChildren.apply(targets[i], Array.from(source.childNodes).map(function (n) {
          return document.importNode(n, true);
        }));
        targets[i].hidden = source.hidden;
      });
      root.dataset.page = next.dataset.page;
      root.dataset.totalPages = next.dataset.totalPages;
      document.querySelector('link[rel="canonical"]').href = canonical.href;
      document.querySelector('meta[property="og:url"]').content = canonical.href;
      if (push) window.history.pushState(null, "", url.pathname + url.search);
      renderedUrl = url.href;
      feedback.textContent = "";
      heading.focus();
    } catch (error) {
      if (active !== controller || error.name === "AbortError") return;
      feedback.textContent = root.dataset.loadError;
      // A click may have aborted a Back/forward read after the address changed.
      if (!push || window.location.href !== renderedUrl) window.location.assign(window.location.href);
    } finally {
      if (active === controller) {
        root.removeAttribute("aria-busy");
        active = null;
      }
    }
  }

  root.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest("a[data-archive-page]");
    if (!link || !root.contains(link) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
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
