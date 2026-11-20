(() => {
  const header = document.querySelector("[data-kit-site-header]");
  const trigger = header?.querySelector(".menu-toggle");
  const sheet = header?.querySelector(".menu-sheet");
  if (!trigger || !sheet || header.hasAttribute("data-menu-ready")) return;
  const compact = matchMedia("(max-width: 820px)");
  let background = [];
  const items = () =>
    Array.from(sheet.querySelectorAll("a[href], button:not(:disabled)")).filter(
      (node) => node.tabIndex >= 0 && node.getClientRects().length,
    );
  const isOpen = () => sheet.hasAttribute("data-open");
  function openMenu(open, restore = false) {
    sheet.toggleAttribute("data-open", open);
    trigger.setAttribute("aria-expanded", String(open));
    if (open)
      background = header.parentElement.querySelectorAll(":scope > :is(main, footer):not([inert])");
    for (const region of background) region.inert = open;
    if (open) items()[0]?.focus();
    else if (restore) trigger.focus();
  }
  header.setAttribute("data-menu-ready", "");
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-expanded", "false");
  sheet.querySelector(".menu-close").hidden = true;
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (compact.matches) openMenu(!isOpen(), isOpen());
  });
  sheet.addEventListener("click", (event) => {
    if (isOpen() && event.target.closest("a[href]")) openMenu(false);
  });
  function onKey(event) {
    if (event.key === " " && event.target === trigger) {
      event.preventDefault();
      if (!event.repeat) trigger.click();
    } else if (isOpen() && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      openMenu(false, compact.matches);
    } else if (isOpen() && event.key === "Tab") {
      const order = [trigger, ...items()];
      const at = order.indexOf(document.activeElement);
      event.preventDefault();
      order[(at + (event.shiftKey ? order.length - 1 : 1)) % order.length].focus();
    }
  }
  document.addEventListener("keydown", onKey, true);
  let focused = header.contains(document.activeElement) ? document.activeElement : null;
  header.addEventListener("focusin", ({ target }) => {
    focused = target;
  });
  header.addEventListener("focusout", ({ target, relatedTarget }) => {
    if (relatedTarget || target.getClientRects().length) focused = null;
  });
  compact.addEventListener("change", ({ matches }) => {
    if (!matches && isOpen()) openMenu(false);
    const active = document.activeElement;
    if (active !== document.body && active !== focused) return;
    if (focused && !focused.getClientRects().length) (matches ? trigger : items()[0])?.focus();
  });
  function adoptFragment() {
    if (!compact.matches || location.hash !== trigger.hash || isOpen()) return;
    openMenu(true);
    history.replaceState(history.state, "", location.pathname + location.search);
  }
  addEventListener("hashchange", adoptFragment);
  adoptFragment();
})();
