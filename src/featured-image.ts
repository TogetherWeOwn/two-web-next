// Match the existing img-src 'self' https://cdn.discordapp.com policy.
// Validate new admin input and suppress blocked images on older/imported rows.
export function featuredImageAllowed(raw: string, appUrl: string): boolean {
  try {
    const image = new URL(raw, appUrl);
    const site = new URL(appUrl);
    return !image.username && !image.password
      && (image.protocol === "http:" || image.protocol === "https:")
      && (image.origin === site.origin || image.origin === "https://cdn.discordapp.com");
  } catch {
    return false;
  }
}
