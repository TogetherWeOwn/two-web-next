/** Select a log label from ordered registration patterns, never from the request URL. */
export function selectRouteLabel(patterns: readonly string[], respondingIndex: number): string {
  const responded = patterns[respondingIndex];
  if (responded && !responded.endsWith("*")) return responded;
  // A wildcard guard or 404 uses the first eligible pattern, if any.
  return patterns.find((pattern) => !pattern.endsWith("*")) ?? "unmatched";
}
