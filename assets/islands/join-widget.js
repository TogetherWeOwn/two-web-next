// SSR leaves a link to Discord's widget page. Enhance it into the inline preview on request only, so /join never contacts Discord until the visitor asks.
(() => {
  const link = document.querySelector("[data-join-widget]");
  const preview = link && link.closest(".join-preview");
  if (!link || !preview) return;

  link.addEventListener("click", (event) => {
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
    const frame = document.createElement("iframe");
    frame.title = "TWO Discord server preview";
    frame.src = link.getAttribute("href");
    frame.width = "350";
    frame.height = "500";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("data-testid", "join-widget");
    let loaded = false;
    let guided = false;
    const guide = (beside) => {
      if (guided) return;
      guided = true;
      const invite = document.querySelector('[data-testid="join-invite"]');
      const href = invite && invite.getAttribute("href");
      const message = document.createElement("p");
      message.setAttribute("data-testid", "join-widget-error");
      message.setAttribute("role", "status");
      message.setAttribute("tabindex", "-1");
      // A post-load timer cannot tell a blocked error page from a real render
      // cross-origin, so beside-frame guidance must not claim failure: it
      // offers the invite path in case the preview is not showing. A frame
      // that never loaded did fail, so the replacing guidance says so.
      message.textContent = beside ? "Preview not showing? " : "The preview failed to load. ";
      let fallback = null;
      if (href) {
        fallback = document.createElement("a");
        fallback.setAttribute("href", href);
        fallback.textContent = "Join with an invite link.";
        message.appendChild(fallback);
      } else {
        message.textContent += "Join with an invite link.";
      }
      // A blocked navigation commits an error page yet fires `load`, which is
      // indistinguishable from a real render cross-origin: keep the frame so a
      // real render keeps working, with the guidance beside it. A frame that
      // never loaded is swapped out so its 500px hole does not strand the
      // guidance below the fold.
      if (beside) preview.appendChild(message);
      else preview.replaceChildren(message);
      const focusIt = (el) => {
        if (el && typeof el.focus === "function") {
          el.focus();
          return true;
        }
        return false;
      };
      const active = document.activeElement;
      // Post-load guidance is announcement-only and never moves focus: a
      // cross-origin parent cannot tell a blocked error-page `load` from a
      // working widget, so `activeElement === frame` is true both for a
      // visitor stranded in a dead frame and for one actively using the
      // widget. The `role=status` message announces the invite fallback and
      // the invite link follows the frame in tab order, so a blocked-embed
      // visitor is one Tab away while a working-widget visitor is never
      // yanked mid-use. Focus moves only where the frame is replaced.
      if (!beside && (!active || active === document.body)) {
        focusIt(fallback) || focusIt(message);
      }
    };
    // The bounded timer survives `load`: a blocked embed fires `load` for its
    // error page, so guidance appears beside the frame when the timer fires.
    // Focus moves in only on `load`, and only when the visitor hasn't moved
    // elsewhere since the click (after replaceChildren the link is gone, so
    // <body> means "hasn't moved"): a late load never steals focus.
    const timer = setTimeout(() => guide(loaded), 8000);
    frame.addEventListener("load", () => {
      if (guided || loaded) return;
      loaded = true;
      const active = document.activeElement;
      if (!active || active === document.body) {
        frame.focus();
      }
    });
    frame.addEventListener("error", () => {
      if (guided || loaded) return;
      clearTimeout(timer);
      guide(false);
    });
    preview.replaceChildren(frame);
  });
})();
