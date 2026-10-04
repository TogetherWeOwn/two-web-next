import { test, expect, qaLogin } from "./fixtures";

const eventKey = "01J00000000000000000000001";

test("member opens an event from the list, RSVPs going, then withdraws", async ({
  page,
  context,
}) => {
  await qaLogin(context, "qa-member");
  await page.goto("/events");
  await page.getByRole("link", { name: "E2E Community Night", exact: true }).first().click();
  await expect(page).toHaveURL(`/e/${eventKey}`);
  await expect(
    page.getByRole("heading", { name: "E2E Community Night", exact: true }),
  ).toBeVisible();
  // Strict browser acceptance: API calls are not a substitute for this control.
  // These testids are frozen in src/islands/contracts.ts (W10 slice 2).
  await expect(page.getByTestId("rsvp-going")).toBeVisible();
  const going = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/events/${eventKey}/rsvp`) && response.request().method() === "PUT",
  );
  await page.getByTestId("rsvp-going").click();
  expect((await going).status()).toBe(201);
  await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
  await page.reload();
  await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
  const withdrawn = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/events/${eventKey}/rsvp`) &&
      response.request().method() === "DELETE",
  );
  await page.getByTestId("rsvp-withdraw").click();
  expect((await withdrawn).status()).toBe(204);
  await expect(page.getByTestId("rsvp-going")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("rsvp-going")).toBeVisible();
  await expect(page.getByTestId("rsvp-confirmed")).toHaveCount(0);
});
