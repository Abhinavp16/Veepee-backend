const crypto = require('crypto');
const { AppError } = require('../utils/errors');

// Protects scheduled-job endpoints. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
// automatically when the CRON_SECRET environment variable is set on the project.
const cronAuth = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return next(new AppError('Cron is not configured', 503, 'CRON_NOT_CONFIGURED'));
  }

  const header = req.get('authorization') || '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  const valid = expected.length === received.length && crypto.timingSafeEqual(expected, received);
  if (!valid) {
    return next(new AppError('Unauthorized', 401, 'CRON_UNAUTHORIZED'));
  }
  next();
};

module.exports = cronAuth;
