const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// Limits are kept in memory per serverless instance: they stop runaway
// clients and password guessing, not determined attackers.

/**
 * The caller's address. On Vercel the platform sets x-vercel-forwarded-for
 * (and overwrites x-forwarded-for), so clients cannot pick their own.
 */
const clientIp = (req) => {
  const vercel = String(req.headers['x-vercel-forwarded-for'] || '').split(',')[0].trim();
  if (vercel) return vercel;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
};

/** The signed-in user's id from a genuine (correctly signed) token. */
const verifiedUserId = (req) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return null;
  try {
    // An expired but genuine token still identifies its owner.
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, { ignoreExpiration: true });
    return payload?.userId ? String(payload.userId) : null;
  } catch {
    return null;
  }
};

const limitReached = (req, res, next, options) => {
  res.status(options.statusCode).json({
    success: false,
    message: 'Too many requests. Please wait a moment and try again.',
    error: { code: 'RATE_LIMIT_EXCEEDED' },
  });
};

const common = {
  standardHeaders: 'draft-6',
  legacyHeaders: true,
  handler: limitReached,
  // Addresses come from clientIp(), not Express's trust-proxy setting.
  validate: { xForwardedForHeader: false, trustProxy: false, ip: false },
};

const numberFrom = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * All API traffic: per signed-in user, or per device address for guests.
 * Generous, because a normal visit makes many small requests.
 */
const createApiLimiter = ({
  max = numberFrom(process.env.API_RATE_LIMIT_MAX, 300),
  windowMs = numberFrom(process.env.API_RATE_LIMIT_WINDOW_MS, 60 * 1000),
} = {}) => rateLimit({
  ...common,
  windowMs,
  max,
  skip: (req) => /^\/api\/v1\/(health|internal\/cron)(\/|$|\?)/.test(req.originalUrl),
  keyGenerator: (req) => {
    const userId = verifiedUserId(req);
    return userId ? `user:${userId}` : `ip:${clientIp(req)}`;
  },
});

const identityOf = (req) => {
  const body = req.body || {};
  const value = body.phone || body.email || body.identifier || '';
  return String(value).trim().toLowerCase();
};

/**
 * Sign-in style routes: only failed attempts count, per phone/email and per
 * address, so guessing passwords or spamming sign-ups is slowed down while
 * people who type their password correctly are never blocked.
 */
const createAuthLimiter = ({
  perIdentity = 10,
  perIp = 30,
  windowMs = 15 * 60 * 1000,
} = {}) => {
  const byIdentity = rateLimit({
    ...common,
    windowMs,
    max: perIdentity,
    skipSuccessfulRequests: true,
    skip: (req) => !identityOf(req),
    keyGenerator: (req) => `auth-id:${identityOf(req)}`,
  });
  const byIp = rateLimit({
    ...common,
    windowMs,
    max: perIp,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `auth-ip:${clientIp(req)}`,
  });
  return [byIdentity, byIp];
};

// The public account-deletion form on the website.
const publicFormLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: numberFrom(process.env.PUBLIC_FORM_RATE_LIMIT_MAX, 10),
  keyGenerator: (req) => `form:${clientIp(req)}`,
});

module.exports = {
  clientIp,
  verifiedUserId,
  createApiLimiter,
  createAuthLimiter,
  publicFormLimiter,
};
