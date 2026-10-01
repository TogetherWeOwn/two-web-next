// Shared profile/attendee avatar fallback. External listeners keep CSP unchanged.
(function () {
  document.querySelectorAll("[data-avatar]").forEach(function (root) {
    var image = root.querySelector("img");
    var initial = root.querySelector("[data-avatar-initial]");
    if (!image || !initial) return;

    function fallback() {
      image.hidden = true;
      initial.hidden = false;
    }

    image.addEventListener("error", fallback);
    // Cached failures can finish before this deferred script attaches its listener.
    if (image.complete && image.naturalWidth === 0) fallback();
  });
})();
