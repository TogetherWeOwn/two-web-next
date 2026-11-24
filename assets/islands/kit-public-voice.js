import { createBrowserLiveTopic } from "../../src/live/browser-topic";

const count = document.getElementById("home-public-voice");
if (count) {
  // The homepage's independent schedule and Discord links are the fallback.
  // There is no independently projected HTTP count read to poll.
  const unavailable = count.textContent;
  const topic = createBrowserLiveTopic(null);
  topic.subscribe(({ value }) => {
    if (value === null) count.textContent = unavailable;
    else if (value.count === null) count.textContent = "Voice count withheld.";
    else count.textContent = `${value.count} in voice right now.`;
  });
  let stop = topic.start();
  window.addEventListener("pagehide", () => stop());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) stop = topic.start();
  });
}
