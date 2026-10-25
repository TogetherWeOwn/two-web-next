// SSR leaves a hidden Share button on published public events. Reveal it only
// when the device offers the Web Share API in a secure context, and share the
// public title plus context-free canonical URL from an explicit user gesture.
// Copy link and the calendar actions stay untouched; cancellation is silent
// and failures never claim success.
(() => {
  const button = document.querySelector("[data-native-share]");
  if (!button) return;
  if (window.isSecureContext === false) return;
  if (typeof navigator.share !== "function") return;
  const status = document.querySelector("[data-native-share-status]");
  const separator = document.querySelector("[data-native-share-sep]");
  const title = button.getAttribute("data-share-title") ?? "";
  const url = button.getAttribute("data-share-url") ?? "";
  // Only one native sheet at a time: ignore repeat activations while pending.
  let pending = false;
  button.hidden = false;
  if (separator) separator.hidden = false;

  function settle(message) {
    pending = false;
    if (status && message) status.textContent = message;
  }

  button.addEventListener("click", () => {
    if (pending) return;
    pending = true;
    if (status) status.textContent = "";
    let sheet;
    try {
      sheet = navigator.share({ title, url });
    } catch {
      settle("Sharing didn't complete — Copy link is still available.");
      return;
    }
    Promise.resolve(sheet).then(
      () => settle(null),
      (error) => {
        if (error && error.name === "AbortError") settle(null);
        else settle("Sharing didn't complete — Copy link is still available.");
      },
    );
  });
})();
