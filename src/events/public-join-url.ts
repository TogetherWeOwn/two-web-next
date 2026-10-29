/** Shared entry and render policy for stored joining links. No URL fetching. */
export function isPublicJoinUrl(value: string): boolean {
  if (!/^https?:\/\/[^/?#@\\\s]+(?:[/?#]|$)/i.test(value) || /[\\\u0000- \u007f]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
