import { parseEventForm } from "../../src/admin/validation";

// Actual Unicode separators, not percent-encoded or literal backslash-u text.
// Each unsafe suffix follows the separator so prefix-only classification leaks it.
export const UNICODE_JOIN_DESTINATIONS = [
  ["NBSP U+00A0", " "],
  ["thin space U+2009", " "],
  ["ideographic space U+3000", "　"],
].flatMap(([name, separator]) =>
  [
    ["fragment", "#fixture-secret"],
    ["query", "?auth=fixture-secret"],
    ["private path", "/private/fixture-secret"],
    ["session path parameter", ";jsessionid=fixture-secret"],
  ].map(([kind, suffix]) => ({
    name: `${name}: ${kind}`,
    destination: `https://call.example.test/open${separator}room${suffix}`,
  })),
);

export const SAFE_JOIN_DESTINATION = "https://call.example.test/open-room";
export const SAFE_JOIN_INSTRUCTIONS = `Use headphones.\nOpen ${SAFE_JOIN_DESTINATION} room for beginners.\nBring a board.`;

export function admittedPrintJoining(destination: string) {
  return parseEventForm({
    title: "Overnight chess & stories",
    starts_at: "2030-01-10 23:30",
    ends_at: "2030-01-11 02:15",
    timezone: "UTC",
    join_url: destination,
    join_instructions: `Use headphones.\nOpen ${destination}\nBring a board.`,
  });
}
