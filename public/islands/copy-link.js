// SSR leaves a usable canonical link. Enhance only when both link and status exist.
(() => {
  const link = document.querySelector("[data-copy-link]");
  const toast = document.querySelector("[data-copy-toast]");
  if (!link || !toast) return;
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
    const text = link.getAttribute("data-copy-link");
    let copied = false;
    try {
      // writeText needs a secure context and can reject (e.g. denied permission).
      // https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // A newer click already owns feedback; do not run the legacy fallback for a stale attempt.
          if (mine !== latest) return;
          copied = fallback(text);
        }
      } else {
        copied = fallback(text);
      }
    } catch {
      copied = false;
    }
    if (mine !== latest) return;
    clearTimeout(timer);
    toast.textContent = copied
      ? "Event link copied."
      : "That link didn't copy — copy it from the address bar.";
    timer = setTimeout(() => {
      if (mine === latest) toast.textContent = "";
    }, 4000);
  }

  link.setAttribute("role", "button");
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    void copy();
  });
  link.addEventListener("keydown", (event) => {
    if (event.key !== " ") return;
    event.preventDefault();
    void copy();
  });
})();
