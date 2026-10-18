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
    let settled = false;
    const guideToInvite = () => {
      if (settled) return;
      settled = true;
      // The invite link lives beside the preview on every /join variant; a
      // failed or hung frame guides there instead of stranding the visitor.
      const invite = document.querySelector('[data-testid="join-invite"]');
      const inviteHref = invite && invite.getAttribute("href");
      const message = document.createElement("p");
      message.setAttribute("data-testid", "join-widget-error");
      message.setAttribute("role", "status");
      message.setAttribute("tabindex", "-1");
      message.textContent = "The preview failed to load. ";
      let fallback = null;
      if (inviteHref) {
        fallback = document.createElement("a");
        fallback.setAttribute("href", inviteHref);
        fallback.textContent = "Join with an invite link.";
        message.appendChild(fallback);
      } else {
        message.textContent += "Join with an invite link.";
      }
      // Swap the dead frame out: it never rendered, so holding its 500px
      // hole open would strand the guidance below the fold.
      preview.replaceChildren(message);
      // The clicked link is gone, so focus fell to <body>: move it onto the
      // guidance (prefer the invite link) so the next Tab reaches forward
      // instead of restarting from the top of the page.
      if (fallback && typeof fallback.focus === "function") fallback.focus();
      else if (typeof message.focus === "function") message.focus();
    };
    // Browsers fire `load` for a cross-origin frame even when its navigation
    // was blocked (X-Frame-Options, CSP, DNS, refused connection, content
    // blocker): there is no reliable `error` for that case, so the `error`
    // listener below is best-effort only and the bounded timer covers a hung
    // frame that fires neither event. Focus moves in only on `load`, and only
    // when the visitor hasn't moved elsewhere since the click (after
    // replaceChildren the clicked link is gone, so <body> means "hasn't
    // moved"): a late load never steals focus from another element.
    const timer = setTimeout(guideToInvite, 8000);
    frame.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const active = document.activeElement;
      if (!active || active === document.body) frame.focus();
    });
    frame.addEventListener("error", () => {
      clearTimeout(timer);
      guideToInvite();
    });
    preview.replaceChildren(frame);
  });
})();
