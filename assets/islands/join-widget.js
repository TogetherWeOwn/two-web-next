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
    preview.replaceChildren(frame);
    // Keep keyboard focus in the preview once the link is gone.
    frame.focus();
  });
})();
