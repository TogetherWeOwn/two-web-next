function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Maxima are inclusive. Use this for already measured bytes, including stream totals. */
export function exceedsByteLimit(bytes: number, maxBytes: number): boolean {
  return bytes > maxBytes;
}

export function exceedsUtf8ByteLimit(value: string, maxBytes: number): boolean {
  return exceedsByteLimit(utf8ByteLength(value), maxBytes);
}

export function fitsUtf8ByteLimit(value: string, maxBytes: number): boolean {
  return utf8ByteLength(value) <= maxBytes;
}

/** String.length counts UTF-16 code units. An astral character takes two. */
export function exceedsCodeUnitLimit(value: string, maxCodeUnits: number): boolean {
  return value.length > maxCodeUnits;
}

/** String iteration counts Unicode code points. An astral character takes one. */
export function exceedsCodePointLimit(value: string, maxCodePoints: number): boolean {
  return [...value].length > maxCodePoints;
}
