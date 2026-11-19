const families: ReadonlyMap<unknown, readonly string[]> = new Map([
  ["API-3", ["ops"]],
  ["API-4", ["feeds", "public-api"]],
  ["API-5", ["admin"]],
  ["API-6", ["auth"]],
  ["API-7", ["event-writes"]],
  ["API-8", ["member-writes"]],
  ["API-9", ["machine"]],
]);
const pageSource = "docs/adr/0001-sveltekit-page-renderer.md#page-families-move-to-kit-before-m0";
const sharedSources: ReadonlySet<unknown> = new Set([
  pageSource,
  "src/index.tsx admin middleware chain; API-0b",
  "src/index.tsx global middleware chain; API-0b",
]);

export const isApiSlice = (value: string) => families.has(value);
export const isCompletionSource = (value: string) => sharedSources.has(value);

// This validates allocation shape, not which branch answers a request.
export function assertRouteClassification(row: object, method: string, path: string) {
  const { kind, hono405, scope, slice, family, source } = row as Record<string, unknown>;
  const validKind =
    (kind === "endpoint" && method !== "ALL" && hono405 === false) ||
    (kind === "middleware" && method === "ALL" && hono405 === false) ||
    (kind === "method-fallback" && hono405 === true);
  const validScope =
    (scope === "api" &&
      source === undefined &&
      typeof family === "string" &&
      families.get(slice)?.includes(family)) ||
    (slice === null &&
      family === null &&
      ((scope === "page-cutover" && kind === "endpoint" && source === pageSource) ||
        (scope === "cross-family" && kind === "middleware" && sharedSources.has(source))));
  if (!validKind || !validScope) throw new Error(`Invalid route classification: ${method} ${path}`);
}
