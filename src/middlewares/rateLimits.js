const rateLimit = require('express-rate-limit');

// The API sits behind Vercel's proxy, so the client address is the first entry
// of X-Forwarded-For. The limit is per serverless instance, which is enough to
// blunt casual abuse of the public forms.
const clientKey = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
};

const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PUBLIC_FORM_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: { xForwardedForHeader: false, trustProxy: false },
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

module.exports = { publicFormLimiter };
