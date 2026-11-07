import { expect, type Page } from "@playwright/test";

export async function expectSavedReviewActions(page: Page, state: string, width: number) {
  if (state === "success") return;
  const actions = page.getByTestId("event-review-actions");
  const back = actions.getByRole("link", { name: "Back to edit", exact: true });
  await expect(back).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const brand = await back.evaluate((element) => getComputedStyle(element).borderTopColor);
  await expect(back).toHaveCSS("color", brand);
  if (width === 390) {
    const bar = await actions.boundingBox();
    const link = await back.boundingBox();
    expect(Math.abs(link!.width - bar!.width)).toBeLessThan(1);
  }
  if (state === "published" || state === "cancelled") {
    await expect(actions.getByTestId("publish-reviewed-event")).toHaveCount(0);
    return;
  }
  const publish = actions.getByTestId("publish-reviewed-event");
  if (width === 390) {
    const button = await publish.boundingBox();
    const link = await back.boundingBox();
    expect(Math.abs(button!.width - link!.width)).toBeLessThan(1);
    expect(Math.abs(button!.x - link!.x)).toBeLessThan(1);
  }
  if (state === "corrections") {
    await expect(publish).toBeDisabled();
    await expect(publish).toHaveCSS("opacity", "0.65");
    await expect(publish).toHaveCSS("cursor", "not-allowed");
    await expect(page.getByTestId("event-review")).not.toContainText("Check it over, then publish");
  } else {
    await expect(publish).toBeEnabled();
    await expect(publish).toHaveCSS("opacity", "1");
    await expect(publish).toHaveCSS("background-color", brand);
    await expect(page.getByTestId("event-review")).toContainText("Check it over, then publish");
  }
}
