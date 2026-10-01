export function readWranglerConfig(text) {
  // Keep quoted strings intact (including URLs and commas) while removing JSONC
  // comments and trailing commas. JSON.parse still rejects malformed input.
  const stringsOrComments = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  const stringsOrTrailingCommas = /"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g;
  const json = text.replace(stringsOrComments, (match) => match.startsWith('"') ? match : " ")
    .replace(stringsOrTrailingCommas, (match) => match === "," ? "" : match);
  return JSON.parse(json);
}
