const assert = require('assert');

// The unverified Google sign-in is removed: any token used to sign into one
// shared account (and could take over a real account with that email).
//
//   GOOGLE_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_google_test?replicaSet=rs0' node tests/googleSignInRemoved.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.GOOGLE_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set GOOGLE_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: GOOGLE_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

async function run() {
  const http = require('http');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const email = `owner-${Date.now().toString(36)}@gmail.com`;
  let owner;

  try {
    // Someone's real account with a Gmail address.
    owner = await User.create({ name: 'Real Owner', email, phone: '9876501234', passwordHash: 'secret123', authProvider: 'email', role: 'buyer' });

    const res = await fetch(`${base}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'anything-at-all', phone: '9876501235' }),
    });
    const json = await res.json().catch(() => ({}));
    assert.strictEqual(res.status, 404, 'the route is gone');
    assert.ok(!json.data?.accessToken, 'no session is handed out');

    const after = await User.findById(owner._id).lean();
    assert.ok(!after.googleId, 'the real account is not linked to Google');
    assert.strictEqual(after.authProvider, 'email');
    assert.strictEqual(await User.countDocuments({ phone: '9876501235' }), 0, 'no account is created');

    console.log('googleSignInRemoved.test.js: all checks passed');
  } finally {
    if (owner) await User.deleteOne({ _id: owner._id });
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
