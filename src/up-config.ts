// Secrets without which sign-in or join cannot work. Presence only: no shape
// or strength check, and the body never names which one is absent. The
// server-side warning lists names, never values (TOG-12400).
export const REQUIRED_SECRETS = [
  "SESSION_SECRET",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
] as const;
type RequiredSecret = (typeof REQUIRED_SECRETS)[number];

export type ConfigReadiness = { config?: "missing" };

export function missingSecrets(env: Partial<Record<RequiredSecret, unknown>>): RequiredSecret[] {
  return REQUIRED_SECRETS.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

// A ready Worker adds nothing to the body, so its shape stays unchanged.
export function configReadiness(env: Partial<Record<RequiredSecret, unknown>>): ConfigReadiness {
  const missing = missingSecrets(env);
  if (missing.length === 0) return {};
  console.warn("Health check found required Worker secrets missing.", { missing });
  return { config: "missing" };
}
