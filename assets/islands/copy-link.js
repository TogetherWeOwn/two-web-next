// SSR leaves the URL in a readonly field for manual copying and hides the
// one-click control until it can really copy. Enhance only when both the
// control and its status exist; revealing the control is that enhancement.
(() => {
  const q = (s) => document.querySelector(s);
  let link = q("[data-copy-link]");
  let toast = q("[data-copy-toast]");
  if (!link || !toast) return;
  const feed = link.getAttribute("data-copy-feed") != null;
  link.hidden = false;
  const manual = "Select the feed URL and copy it manually in your calendar app.";
  // Unsettled clipboard promises get truthful feedback at 5 s; the feedback contract caps this at 10 s.
  const feedbackDeadlineMs = 5000;
  const resetMs = 4000;
  let timer;
  // Monotonic attempt token: only the newest click may touch the toast or timer.
  let latest = 0;

  function fallback(text) {
    const active = document.activeElement;
    const selection = window.getSelection();
    const ranges = [];
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));
    }
    const field = document.createElement("textarea");
    field.value = text;
    field.className = "sr-only";
    field.setAttribute("readonly", "");
    field.setAttribute("aria-hidden", "true");
    field.tabIndex = -1;
    document.body.appendChild(field);
    try {
      field.select();
      // Required legacy fallback; execCommand is deprecated, Clipboard API is preferred.
      // https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
      return document.execCommand("copy");
    } finally {
      field.remove();
      if (active) active.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach((range) => selection.addRange(range));
      }
    }
  }

  async function copy() {
    const mine = ++latest;
    // Drop the previous owner's feedback even if this attempt remains pending.
    clearTimeout(timer);
    toast.textContent = "";
    const text = link.getAttribute("data-copy-link");
    let pending = true;
    const owns = () => pending && mine === latest;
    timer = setTimeout(() => {
      if (!owns()) return;
      pending = false;
      toast.textContent = feed
        ? manual
        : "Copy not confirmed — if it isn't on your clipboard, copy the link from the address bar.";
      timer = setTimeout(() => {
        if (mine === latest) toast.textContent = "";
      }, resetMs);
    }, feedbackDeadlineMs);
    let copied = false;
    try {
      // writeText needs a secure context and can reject (e.g. denied permission).
      // https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // A newer click or an expired deadline owns feedback; never fall back for it.
          if (!owns()) return;
          copied = !feed && fallback(text);
        }
      } else {
        copied = !feed && fallback(text);
      }
    } catch {
      copied = false;
    }
    if (!owns()) return;
    pending = false;
    clearTimeout(timer);
    toast.textContent = copied
      ? feed
        ? "Calendar feed URL copied."
        : "Event link copied."
      : feed
        ? manual
        : "That link didn't copy — copy it from the address bar.";
    timer = setTimeout(() => {
      if (mine === latest) toast.textContent = "";
    }, resetMs);
  }

  // Event controls stay links: plain activation copies, modified clicks and
  // keys keep native navigation. Feed controls use native button activation.
  function onClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    void copy();
  }
  function onKey(event) {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      (event.key !== " " && event.key !== "Enter")
    )
      return;
    event.preventDefault();
    if (event.repeat) return;
    void copy();
  }
  link.addEventListener("click", onClick);
  // Native buttons already synthesize one click for Enter/Space.
  if (!feed) link.addEventListener("keydown", onKey);
  // Calendar fragment swaps replace the feed button node: rebind the newest
  // node when it changes so the copy action follows the committed scope.
  // Pages without swaps (event, past archive) and hosts without observers
  // keep the single binding above. Only the calendar feed button swaps, so
  // only click rebinds: putting the event link in a swapped zone must also
  // rebind keydown (Space) there.
  if (window.MutationObserver) {
    new MutationObserver(() => {
      const now = q("[data-copy-link]");
      if (now && now !== link) {
        link = now;
        toast = q("[data-copy-toast]");
        if (feed) now.hidden = false;
        now.addEventListener("click", onClick);
      }
    }).observe(document, { childList: true, subtree: true });
  }
})();
