import type { Locator } from "@playwright/test";

export function accessibleJoinOneclick(landmark: Locator): Locator {
  return landmark
    .getByTestId("join-oneclick")
    .and(landmark.getByRole("link", { name: "Join with Discord", exact: true }));
}
