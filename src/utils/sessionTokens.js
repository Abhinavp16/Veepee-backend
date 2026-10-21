// Seconds in a duration string like "15m", "12h", "7d" (as used in JWT_* env vars).
const toSeconds = (value, fallback) => {
  const match = /^(\d+)\s*([smhd])$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  return Number(match[1]) * unit;
};

const ACCESS_SECONDS = () => toSeconds(process.env.JWT_ACCESS_EXPIRY, 15 * 60);
const REFRESH_SECONDS = () => toSeconds(process.env.JWT_REFRESH_EXPIRY, 7 * 86400);

// Admins and staff sign in for a fixed working session: it can be refreshed,
// but never past 5 hours after the original sign-in. DASHBOARD_SESSION_LENGTH
// ("5h", "90s", ...) shortens it for testing.
const DASHBOARD_SESSION_SECONDS = () => toSeconds(process.env.DASHBOARD_SESSION_LENGTH, 5 * 3600);

/**
 * Expiry (epoch seconds) for a token whose lifetime is `lifetimeSeconds`,
 * never later than the session's hard end (epoch seconds) when there is one.
 */
const tokenExpiry = (lifetimeSeconds, sessionEndsAtSeconds, nowSeconds = Math.floor(Date.now() / 1000)) => {
  const natural = nowSeconds + lifetimeSeconds;
  return sessionEndsAtSeconds ? Math.min(natural, sessionEndsAtSeconds) : natural;
};

module.exports = {
  toSeconds,
  ACCESS_SECONDS,
  REFRESH_SECONDS,
  DASHBOARD_SESSION_SECONDS,
  tokenExpiry,
};
