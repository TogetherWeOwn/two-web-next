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
      // blocked or hung frame guides there instead of stranding the visitor.
      const invite = document.querySelector('[data-testid="join-invite"]');
      const inviteHref = invite && invite.getAttribute("href");
      const message = document.createElement("p");
      message.setAttribute("data-testid", "join-widget-error");
      message.setAttribute("role", "status");
      message.textContent = "The preview failed to load. ";
      if (inviteHref) {
        const fallback = document.createElement("a");
        fallback.setAttribute("href", inviteHref);
        fallback.textContent = "Join with an invite link.";
        message.appendChild(fallback);
      } else {
        message.textContent += "Join with an invite link.";
      }
      // Swap the dead frame out: it never rendered, so holding its 500px
      // hole open would strand the guidance below the fold.
      preview.replaceChildren(message);
    };
    // A blocked embed fires `error`; a hung one never fires `load`, so a
    // bounded timer fires the same guided fallback. Focus stays put either
    // way: it moves in only on `load`, and a late load never steals it back.
    const timer = setTimeout(guideToInvite, 8000);
    frame.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      frame.focus();
    });
    frame.addEventListener("error", () => {
      clearTimeout(timer);
      guideToInvite();
    });
    preview.replaceChildren(frame);
  });
})();
