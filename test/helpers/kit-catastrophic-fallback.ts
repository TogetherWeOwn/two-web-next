import { readFileSync } from "node:fs";
import { URL } from "node:url";

export const catastrophicTemplate = readFileSync(
  new URL("../../web/src/error.html", import.meta.url),
  "utf8",
);

// Synthetic only: recognizable in HTML, attributes, titles and visible copy.
export const privateFailureMessages = [
  "TEST_ONLY_PRIVATE_DETAIL: database unavailable at private-fixture.invalid; session=fixture-only",
  '</h1><script>globalThis.fallbackInjected = true</script><img src="https://leak.invalid/pixel" onerror="globalThis.fallbackInjected = true">TEST_ONLY_PRIVATE_DETAIL',
  "TEST_ONLY_PRIVATE_DETAIL <>&\"' $&\nError: fixture failure\n    at private-handler.ts:42:7",
];

// SvelteKit escapes the message before substituting these two template tokens.
// This fixture mounts the standalone document, not the normal Kit layout or a
// live error endpoint. HTTP status behavior is covered by the neighboring suites.
export function renderCatastrophicFallback(status: number, message: string): string {
  const escaped = message.replace(/[&<]/g, (character) => (character === "&" ? "&amp;" : "&lt;"));
  return catastrophicTemplate
    .replace(/%sveltekit\.status%/g, () => String(status))
    .replace(/%sveltekit\.error\.message%/g, () => escaped);
}
