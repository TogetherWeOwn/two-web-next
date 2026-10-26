// SSR leaves usable native controls. Enhance each copy control with its own
// status: a page can carry several (event link, calendar feed, schedule
// view), and one control's clipboard attempt must never copy another's value
// or write another's feedback.
(() => {
  const feedManual = "Select the feed URL and copy it manually in your calendar app.";
  const viewManual = "Select the view URL and copy it manually.";
  // Unsettled clipboard promises get truthful feedback at 5 s; the feedback contract caps this at 10 s.
  const feedbackDeadlineMs = 5000;
  const resetMs = 4000;

  // Legacy selectable-text copy for event links. Any failure here (including
  // execCommand throwing) reports as "not copied", never as a success.
  function fallback(text) {
    const active = document.activeElement;
    const selection = window.getSelection();
    const ranges = [];
    for (let i = 0; selection && i < selection.rangeCount; i++)
      ranges.push(selection.getRangeAt(i));
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
    } catch {
      return false;
    } finally {
      field.remove();
      if (active) active.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach((range) => selection.addRange(range));
      }
    }
  }

  // One binding per control node. The captured link/toast pair, timer and
  // attempt token are this control's alone: once a fragment swap detaches
  // either node the binding loses feedback ownership, so a late clipboard
  // settlement can touch neither the detached status nor its replacement.
  function bind(link, toast) {
    // Controls with a visible readonly field (feed, view) are native buttons,
    // hidden until enhanced, and point at manual selection on failure instead
    // of claiming the legacy fallback copied. Event controls stay links and
    // carry no manual guidance; the feed is told apart by its exact guidance.
    const manual =
      link.getAttribute("data-copy-feed") != null
        ? feedManual
        : link.getAttribute("data-copy-view") != null
          ? viewManual
          : null;
    if (manual) link.hidden = false;
    let timer;
    // Monotonic attempt token: only the newest click may touch the toast or timer.
    let latest = 0;

    async function copy() {
      const mine = ++latest;
      // Drop the previous owner's feedback even if this attempt remains pending.
      clearTimeout(timer);
      toast.textContent = "";
      const text = link.getAttribute("data-copy-link");
      const owns = () =>
        mine === latest && link.isConnected !== false && toast.isConnected !== false;
      // Showing feedback mints a fresh token: the attempt that produced it
      // can no longer settle over it, and only this token may clear it.
      const show = (text) => {
        const shown = ++latest;
        toast.textContent = text;
        timer = setTimeout(() => {
          if (shown === latest && toast.isConnected !== false) toast.textContent = "";
        }, resetMs);
      };
      timer = setTimeout(() => {
        if (!owns()) return;
        show(
          manual ??
            "Copy not confirmed — if it isn't on your clipboard, copy the link from the address bar.",
        );
      }, feedbackDeadlineMs);
      let copied = false;
      try {
        // writeText needs a secure context and can reject (e.g. denied
        // permission); a missing Clipboard API throws here too, landing in
        // the same fallback as a denial.
        // https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // A newer click or an expired deadline owns feedback; never fall back for it.
        if (!owns()) return;
        copied = !manual && fallback(text);
      }
      if (!owns()) return;
      clearTimeout(timer);
      show(
        copied
          ? manual === feedManual
            ? "Calendar feed URL copied."
            : manual
              ? "View copied."
              : "Event link copied."
          : (manual ?? "That link didn't copy — copy it from the address bar."),
      );
    }

    // Modified or already-cancelled activations keep native behavior.
    const blocked = (event) =>
      event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
    // Event controls stay links: plain activation copies, modified clicks and
    // keys keep native navigation. Feed/view controls use native button activation.
    function onClick(event) {
      if (blocked(event) || event.button !== 0) return;
      event.preventDefault();
      void copy();
    }
    function onKey(event) {
      if (blocked(event) || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault();
      if (event.repeat) return;
      void copy();
    }
    link.addEventListener("click", onClick);
    // Native buttons already synthesize one click for Enter/Space.
    if (!manual) link.addEventListener("keydown", onKey);
  }

  // SSR emits one status per control in the same document order (event
  // share block; schedule view then feed; feed alone on the archive), so the
  // nth control owns the nth status. The browser acceptance pins that order
  // by asserting the two calendar statuses never cross.
  function scan() {
    const all = (selector) =>
      document.querySelectorAll
        ? document.querySelectorAll(selector)
        : [document.querySelector(selector)];
    const toasts = all("[data-copy-toast]");
    all("[data-copy-link]").forEach((link, i) => {
      if (!toasts[i] || link._c) return;
      link._c = true;
      bind(link, toasts[i]);
    });
  }
  scan();
  // Calendar fragment swaps replace control nodes inside the swapped zones:
  // bind each newest node so the copy actions follow the committed snapshot.
  // Pages without swaps and hosts without observers keep the binding above.
  if (window.MutationObserver) {
    new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  }
})();
