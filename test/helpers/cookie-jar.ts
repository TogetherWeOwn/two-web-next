/** Single-origin fixture cookies: replace by name and honor deletion, never concatenate old signatures. */
export function mergeCookies(previous: string, response: Response): string {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair]),
  );
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0]!;
    const name = pair.slice(0, pair.indexOf("="));
    if (/Max-Age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}
