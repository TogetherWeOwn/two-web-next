// Production apex. Anything else serving HTML is staging, a preview, or a
// dev/test host — crawlers must not index it.
const PRODUCTION_APEX = "togetherweown.com";

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// Both configuration and serving host must identify the apex. Without a
// serving host, retain the config-only verdict; invalid configuration fails closed.
export function robotsTagFor(appUrl: string, servingHost?: string): string | null {
  const configHost = hostOf(appUrl);
  if (configHost === null) return "noindex, nofollow";
  if (configHost !== PRODUCTION_APEX) return "noindex, nofollow";
  if (servingHost !== undefined && servingHost.toLowerCase() !== PRODUCTION_APEX) {
    return "noindex, nofollow";
  }
  return null;
}
