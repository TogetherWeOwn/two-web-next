import { STAGING_APP_URL } from "../qa";

const ULID_KEY = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const SEED_KEY = /^seed-calendar-(0[1-9]|[1-4][0-9]|50)$/;

// Production keeps the ULID contract. Demo fixtures are addressable only on
// staging/local bindings, never by widening the production route's key parser.
export function eventKeyAllowed(key: string, appUrl: string): boolean {
  const demoApp =
    appUrl === STAGING_APP_URL || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(appUrl);
  return ULID_KEY.test(key) || (demoApp && SEED_KEY.test(key));
}
