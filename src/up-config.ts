// Secrets without which sign-in or join cannot work. Presence only for the
// Discord pair: no shape or strength check, and the body never names which
// one is absent. The server-side warning lists names, never values (TOG-12400).
export const REQUIRED_SECRETS = [
  "SESSION_SECRET",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
] as const;
type RequiredSecret = (typeof REQUIRED_SECRETS)[number];

// Documented floor for SESSION_SECRET (docs/config.md): at least 32
// characters as configured, with no leading or trailing whitespace. The
// local example recommends 32+ random bytes; every boundary fixture is
// ASCII, so a character count and a UTF-8 byte count agree there, and
// multibyte boundary counting is deliberately unpinned.
export const SESSION_SECRET_MIN_LENGTH = 32;

export type ConfigReadiness = { config?: "missing" | "weak" };

export function missingSecrets(env: Partial<Record<RequiredSecret, unknown>>): RequiredSecret[] {
  return REQUIRED_SECRETS.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

function isWeakSessionSecret(value: unknown): boolean {
  // Absent, empty and whitespace-only values belong to the missing-secret
  // refusal above; this gate owns only configured-but-weak values.
  if (typeof value !== "string" || value.trim() === "") return false;
  return value.length < SESSION_SECRET_MIN_LENGTH || value !== value.trim();
}

// A ready Worker adds nothing to the body, so its shape stays unchanged.
// A weak SESSION_SECRET refuses like a missing one (503 with a `config`
// key) but under its own token, so operators can tell an absent secret
// from one that fails the documented strength floor. The weak session key
// is checked first: it is the live-signing risk, so its signal must not
// wait behind an unrelated missing secret. Absent, empty and
// whitespace-only values are not weak (they belong to the missing refusal),
// so pure-missing cases keep their exact token and log line.
export function configReadiness(env: Partial<Record<RequiredSecret, unknown>>): ConfigReadiness {
  if (isWeakSessionSecret(env["SESSION_SECRET"])) {
    console.warn(
      `Health check found SESSION_SECRET too weak: it must be at least ${SESSION_SECRET_MIN_LENGTH} characters with no leading or trailing whitespace.`,
      { secret: "SESSION_SECRET" },
    );
    return { config: "weak" };
  }
  const missing = missingSecrets(env);
  if (missing.length === 0) return {};
  console.warn("Health check found required Worker secrets missing.", { missing });
  return { config: "missing" };
}
