// Parse only the generator's known initializers, never code.
export function parseLeafModule(source) {
  const packed =
    /^(?:\/\/[^\n\r\u2028\u2029]*\n)*import \{ decodeCssDictionary \} from "\.\/css-dictionary";\nexport const LEAF_CRITICAL_CSS: string =\n {2}decodeCssDictionary\(("(?:[^"\\\n\r]|\\.)*"), (\[(?:"(?:[^"\\\n\r]|\\.)*"(?:,"(?:[^"\\\n\r]|\\.)*")*)?\])\);\nexport const LEAF_CRITICAL_CSS_SHA256: string = "([A-Za-z0-9+/]{43}=)";\n$/.exec(
      source,
    );
  if (packed) {
    try {
      const value = JSON.parse(packed[1]);
      const dictionary = JSON.parse(packed[2]);
      if (
        value.length > 100_000 ||
        dictionary.length > 80 ||
        dictionary.some((entry) => !/^[\x20-\x7e]{4,24}$/u.test(entry))
      ) {
        return null;
      }
      let css = "";
      for (let i = 0; i < value.length; i++) {
        const marker = value.charCodeAt(i) - 0x80;
        const piece = marker >= 0 && marker < 80 ? dictionary[marker] : value[i];
        if (piece === undefined || css.length + piece.length > 100_000) return null;
        css += piece;
      }
      return { css, sha256: packed[3] };
    } catch {
      return null;
    }
  }
  const match =
    /^(?:\/\/[^\n\r\u2028\u2029]*\n)*export const LEAF_CRITICAL_CSS: string =\n {2}("(?:[^"\\\n\r]|\\.)*")(\.split\("~"\)\.join\("\.base-theme"\))?;\nexport const LEAF_CRITICAL_CSS_SHA256: string = "([A-Za-z0-9+/]{43}=)";\n$/.exec(
      source,
    );
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return { css: match[2] ? value.split("~").join(".base-theme") : value, sha256: match[3] };
  } catch {
    return null;
  }
}
