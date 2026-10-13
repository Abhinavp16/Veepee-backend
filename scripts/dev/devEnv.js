// Development environment for the API: a local database and throwaway
// secrets. Never loads .env, so production credentials (database, Firebase,
// Cloudinary, Razorpay) cannot be used by accident.
const DEFAULT_URI = 'mongodb://127.0.0.1:27233/oxon_dev?replicaSet=rs0';

const uri = process.env.DEV_MONGODB_URI || DEFAULT_URI;
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to start: DEV_MONGODB_URI must point at a database on this machine.');
  process.exit(1);
}

for (const key of Object.keys(process.env)) {
  if (/^(FIREBASE_|CLOUDINARY_|RAZORPAY_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  MONGODB_URI: uri,
  NODE_ENV: 'development',
  JWT_SECRET: 'dev-only-secret-not-for-production-0123456789',
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || '15m',
  JWT_REFRESH_EXPIRY: '7d',
  CRON_SECRET: 'dev-cron-secret',
  RATE_LIMIT_MAX_REQUESTS: '100000',
});

module.exports = { uri };
