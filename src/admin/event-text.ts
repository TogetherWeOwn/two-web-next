/** Single-line controls strip breaks; render accepted multiline values as textareas. */
export function eventTextHasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}
