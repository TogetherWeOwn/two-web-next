import { expect, type Page, type Response } from "@playwright/test";

const lobby = "The lobby is open.";
const scheduled = String.raw`Next game night: \S(?:.*\S)?\. Come play with us\.`;
const rsvp = String.raw`Your next RSVP: \S(?:.*\S)?\. You're (?:going|on the waitlist)\.`;

export async function signOutToHome(page: Page, homeUrl: string): Promise<Response> {
  // Wait for the committed GET, not the transient 303 from the form POST.
  const [guestHome] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === homeUrl &&
        response.request().method() === "GET" &&
        response.request().isNavigationRequest() &&
        response.frame() === page.mainFrame(),
    ),
    page.getByRole("button", { name: "Sign out" }).click(),
  ]);
  return guestHome;
}

export async function homeArrivalHeading(
  page: Page,
  response: Response | null,
  visitor: "guest" | "member",
) {
  if (!response) throw new Error("Missing Home navigation response");
  const renderer = await response.headerValue("x-two-renderer");
  expect([null, "kit"]).toContain(renderer);

  const name =
    renderer === "kit"
      ? new RegExp(
          `^(?:The lobby is open\\.|${scheduled}${visitor === "member" ? `|${rsvp}` : ""})$`,
        )
      : lobby;
  return page
    .getByRole("heading", { level: 1, name, exact: true })
    .and(page.locator("h1#home-heading"));
}
