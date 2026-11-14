/** Return whether the header explicitly permits gzip, or permits it via `*`. */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;

  let gzip: number | undefined;
  let wildcard: number | undefined;
  for (const entry of header.split(",")) {
    const [coding, ...params] = entry.trim().toLowerCase().split(";");
    const name = coding.trim();
    if (name !== "gzip" && name !== "*") continue;

    // Invalid or repeated parameters do not grant permission to encode.
    const match =
      params.length === 1 ? /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(params[0]) : null;
    const quality = params.length === 0 ? 1 : match ? Number(match[1]) : 0;
    if (name === "gzip") gzip = Math.min(gzip ?? 1, quality);
    else wildcard = Math.min(wildcard ?? 1, quality);
  }
  return (gzip ?? wildcard ?? 0) > 0;
}
