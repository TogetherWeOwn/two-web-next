// Hono adapter over the RSVP refusal model.
//
// Renders the served no-JS refusal page byte-for-byte: the branded event shell
// (viewport, skip link, main landmark, stylesheets, header/footer), the
// failure heading, the announced message and the return-to-event link. Only
// signed-in members reach this page (a missing session redirects to login
// before it), so the shell stays presentational with account={false} — like
// the cancelled (410) event page — instead of rendering guest sign-in chrome
// for a member. The model carries only display copy and the server-built
// return path, never a submitted body, so no raw-HTML rendering is needed.
import { EventDetailShell } from "./pages-shared";
import type { RsvpRefusalModel } from "./rsvp-refusal";

export function renderRsvpRefusal(model: RsvpRefusalModel) {
  return (
    <EventDetailShell title={model.title} account={false}>
      <h1>{model.title}</h1>
      <p role="alert">{model.message}</p>
      <a href={model.returnPath}>Return to the event</a>
    </EventDetailShell>
  );
}
