import { acceptsJson } from "../media-type";

function varyWithAccept(vary: string | null): string {
  if (!vary) return "Accept";
  const dimensions = vary.split(",").map((value) => value.trim().toLowerCase());
  return dimensions.includes("accept") ? vary : `${vary}, Accept`;
}

/** Response policy for an explicitly registered, Accept-varying 405. The router supplies Allow. */
export function explicitMethodRefusal(input: {
  allow: string;
  accept: string | null | undefined;
  vary: string | null;
}) {
  const { allow, accept, vary } = input;
  return {
    status: 405,
    headers: { Allow: allow, Vary: varyWithAccept(vary) },
    error: acceptsJson(accept) ? "method_not_allowed" : null,
  } as const;
}
