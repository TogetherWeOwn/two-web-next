/** Single-line controls strip breaks; render accepted multiline values as textareas. */
export function eventTextHasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/** HTML parsing discards the first line break right after a textarea start tag. */
export function textareaInitialText(value: string): string {
  return /^[\r\n]/.test(value) ? `\n${value}` : value;
}
