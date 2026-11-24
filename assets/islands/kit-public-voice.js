import { createBrowserLiveTopic } from "../../src/live/browser-topic";

const count = document.querySelector("#home-public-voice, [data-public-voice-count]");
if (count) {
  // Event detail leaves the rail alone while a public count is unavailable.
  // Neither page has an independently projected HTTP count to poll.
  const panel = count.closest("[data-public-voice-panel]");
  const unavailable = count.textContent;
  const topic = createBrowserLiveTopic(null);
  topic.subscribe(({ value }) => {
    if (panel) {
      const total = value?.count;
      count.textContent = total == null ? "" : `${total} in voice right now.`;
      panel.hidden = total == null;
    } else if (value === null) count.textContent = unavailable;
    else if (value.count === null) count.textContent = "Voice count withheld.";
    else count.textContent = `${value.count} in voice right now.`;
  });
  let stop = topic.start();
  window.addEventListener("pagehide", () => stop());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) stop = topic.start();
  });
}
