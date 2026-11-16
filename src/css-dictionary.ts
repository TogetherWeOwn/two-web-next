// Decode the build-time CSS dictionary without evaluating generated code.
const FIRST_MARKER = 0x80;
const MAX_ENTRIES = 80;
const MAX_CSS_LENGTH = 100_000;

export function decodeCssDictionary(packed: string, dictionary: readonly string[]): string {
  if (
    packed.length > MAX_CSS_LENGTH ||
    dictionary.length > MAX_ENTRIES ||
    dictionary.some((entry) => !/^[\x20-\x7e]{4,24}$/u.test(entry))
  ) {
    throw new Error("Invalid CSS dictionary");
  }

  let length = 0;
  const pieces: string[] = [];
  for (let i = 0; i < packed.length; i++) {
    const code = packed.charCodeAt(i);
    const marker = code - FIRST_MARKER;
    const piece = marker >= 0 && marker < MAX_ENTRIES ? dictionary[marker] : packed[i];
    if (piece === undefined || (length += piece.length) > MAX_CSS_LENGTH) {
      throw new Error("Invalid CSS dictionary data");
    }
    pieces.push(piece);
  }
  return pieces.join("");
}
