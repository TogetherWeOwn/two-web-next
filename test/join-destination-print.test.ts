// Printable join destinations: only a bare public room URL is readable on
// paper. Bearer tokens, session ids and return context travel in the query,
// so anything credential-shaped stays a screen-only hyperlink.
import { describe, expect, it } from "vitest";
import { isPrintableJoinDestination } from "../src/events/feeds";

describe("isPrintableJoinDestination", () => {
  it.each([
    "https://call.example.test/open-room",
    "http://call.example.test/open-room",
    "https://call.example.test/rooms/friday-chess/",
  ])("prints a bare public destination: %s", (url) => {
    expect(isPrintableJoinDestination(url)).toBe(true);
  });

  it.each([
    "https://call.example.test/private-room?token=fixture-bearer&session=fixture-context",
    "https://call.example.test/open-room?token=abc",
    "https://call.example.test/open-room?next=%2Fmembers",
    "https://call.example.test/open-room#session=abc",
    "https://call.example.test/private-room",
    "https://call.example.test/lobby/private",
    "https://call.example.test/Private_Room",
    "not a url",
    "/relative/room",
    "ftp://call.example.test/open-room",
    "javascript:window.print()",
  ])("never prints a credential-shaped destination: %s", (url) => {
    expect(isPrintableJoinDestination(url)).toBe(false);
  });

  it("does not treat a private substring as a private segment", () => {
    expect(isPrintableJoinDestination("https://call.example.test/privateer-lodge")).toBe(true);
  });
});
