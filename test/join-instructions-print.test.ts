// Paper-only instruction projection rejects recognized credential forms while
// retaining ordinary guidance unchanged.
import { describe, expect, it } from "vitest";
import { isPrintableJoinDestination, printableJoinInstructions } from "../src/events/feeds";
import {
  SAFE_JOIN_INSTRUCTIONS,
  UNICODE_JOIN_DESTINATIONS,
  admittedPrintJoining,
} from "./helpers/event-print-joining-fixtures";

describe("additional credential path forms", () => {
  it.each([
    "https://call.example.test/private%5csecret",
    "https://call.example.test/open-room%3Bjsessionid=fixture-session",
    "https://call.example.test/session/fixture-session",
    "https://call.example.test/sessionid=fixture-session",
    "https://call.example.test/open-room%3Ftoken=fixture-token",
  ])("keeps the credential-shaped destination off paper: %s", (url) => {
    expect(isPrintableJoinDestination(url)).toBe(false);
  });
});

describe("printableJoinInstructions", () => {
  // Catches a URL matcher that treats Unicode whitespace inside an admitted
  // destination as the end of that destination, retaining its unsafe suffix.
  it.each(UNICODE_JOIN_DESTINATIONS)(
    "omits the complete admitted Unicode destination line: $name",
    ({ destination }) => {
      const parsed = admittedPrintJoining(destination);
      expect(parsed.join_url, "CONTROL: real form validation admits the complete URL").toBe(
        destination,
      );
      expect(parsed.join_instructions).toBe(`Use headphones.\nOpen ${destination}\nBring a board.`);
      expect(isPrintableJoinDestination(parsed.join_url!), "CONTROL: whole URL is unsafe").toBe(
        false,
      );
      expect(printableJoinInstructions(parsed.join_instructions!)).toBe(
        "Use headphones.\nBring a board.",
      );
    },
  );

  it("CONTROL: keeps ordinary ASCII-space prose after a harmless URL", () => {
    expect(printableJoinInstructions(SAFE_JOIN_INSTRUCTIONS)).toBe(SAFE_JOIN_INSTRUCTIONS);
  });

  it.each([
    "Use headphones.",
    "Use headphones.\nBring a board.",
    "Open https://call.example.test/open-room",
    "Use headphones.\nOpen https://call.example.test/o'connor room\nBring a board.",
    "There is a session for beginners.",
  ])("retains harmless instructions: %s", (instructions) => {
    expect(printableJoinInstructions(instructions)).toBe(instructions);
  });

  it.each([
    "https://call.example.test/private-room?token=fixture-bearer&session=fixture-context",
    "https://call.example.test/private%2fsecret",
    "https://call.example.test/open-room;jsessionid=fixture-session",
    "https://fixture-user:fixture-password@call.example.test/open-room",
    "//call.example.test/private-room",
  ])("omits a sensitive URL line without losing harmless lines: %s", (url) => {
    expect(printableJoinInstructions(`Use headphones.\nOpen ${url}\nBring a board.`)).toBe(
      "Use headphones.\nBring a board.",
    );
  });

  it.each([
    "https://call.example.test/open-room'fixture#fixture-secret",
    "https://call.example.test/open-room'fixture?auth=fixture-secret",
    "https://o'connor:fixture-password@call.example.test/open-room",
    'https://call.example.test/open-room"fixture#fixture-secret',
    "https://call.example.test/open-room<fixture#fixture-secret",
  ])("classifies the complete URL before retaining its instruction line: %s", (url) => {
    expect(isPrintableJoinDestination(url), "CONTROL: the whole destination is unsafe").toBe(false);
    expect(printableJoinInstructions(`Use headphones.\nOpen ${url}\nBring a board.`)).toBe(
      "Use headphones.\nBring a board.",
    );
  });

  it.each(["Token: fixture-bearer", "Session ID=fixture-session", "Authorization: fixture-bearer"])(
    "omits a labeled credential without requiring a URL: %s",
    (instruction) => {
      expect(printableJoinInstructions(instruction)).toBe("");
    },
  );

  it("omits the whole line if any destination is sensitive", () => {
    expect(
      printableJoinInstructions(
        "Open https://call.example.test/open-room or https://call.example.test/private-room",
      ),
    ).toBe("");
  });
});
