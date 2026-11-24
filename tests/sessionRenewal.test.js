const assert = require('assert');

// Staying signed in: renewing the sign-in swaps the renewal token. If the
// phone never receives the new one (a lost reply), presenting the old one
// again is accepted while the new one is unused, instead of signing the
// person out; once the new one has been used, the old one is refused.
//
//   SESSION_RENEWAL_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_session_renewal_test?replicaSet=rs0' node tests/sessionRenewal.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.JWT_REFRESH_EXPIRY; // the default (60 days) is what's tested
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.SESSION_RENEWAL_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set SESSION_RENEWAL_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: SESSION_RENEWAL_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, RefreshToken } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const renew = (refreshToken) => call('POST', '/auth/refresh-token', { refreshToken });
  const made = [];

  try {
    const phone = randomPhone();
    const user = await User.create({ name: 'Renewal buyer', phone, passwordHash: 'Buyer@123', authProvider: 'email', role: 'buyer' });
    made.push(user._id);

    let res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const first = res.json.data.refreshToken;

    // 1. Signed in for 60 days, starting again at each renewal.
    const days = (token) => (jwt.decode(token).exp * 1000 - Date.now()) / 86400000;
    assert.ok(days(first) > 59.9 && days(first) <= 60, `refresh lasts 60 days, got ${days(first)}`);
    console.log('ok - signed in for 60 days');

    // 2. A normal renewal gives a new pair; nothing internal is sent.
    res = await renew(first);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const second = res.json.data.refreshToken;
    assert.notStrictEqual(second, first);
    assert.ok(!('recordId' in res.json.data), 'the stored record id is not sent');
    console.log('ok - a renewal gives a new pair');

    // 3. The reply was lost: the phone still has `second`'s predecessor? No:
    //    simulate it on the next renewal. Renew `second` (reply lost), then
    //    present `second` again: accepted, the unused `third` is cancelled.
    res = await renew(second);
    assert.strictEqual(res.status, 200);
    const third = res.json.data.refreshToken; // the phone never got this
    res = await renew(second);
    assert.strictEqual(res.status, 200, `lost reply recovered: ${JSON.stringify(res.json)}`);
    const fourth = res.json.data.refreshToken;
    res = await renew(third);
    assert.strictEqual(res.status, 401, 'the token the phone never got is cancelled');
    // Lost again: still recovered while the newest one is unused.
    res = await renew(second);
    assert.strictEqual(res.status, 200, 'a second lost reply is recovered too');
    const fifth = res.json.data.refreshToken;
    res = await renew(fourth);
    assert.strictEqual(res.status, 401);
    console.log('ok - a lost reply does not sign the person out');

    // 4. Once the new token has been used, the old one is refused (a copy).
    res = await renew(fifth);
    assert.strictEqual(res.status, 200);
    const sixth = res.json.data.refreshToken;
    res = await renew(second);
    assert.strictEqual(res.status, 401, 'an old token after its replacement was used is refused');
    res = await renew(sixth);
    assert.strictEqual(res.status, 200, 'the latest still works');
    const seventh = res.json.data.refreshToken;
    console.log('ok - a token copied and used later is refused');

    // 5. Signing out ends it for good, even for an earlier token.
    const access = (await renew(seventh)).json.data;
    res = await call('POST', '/auth/logout', { refreshToken: access.refreshToken }, access.accessToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    res = await renew(access.refreshToken);
    assert.strictEqual(res.status, 401, 'signed out');
    res = await renew(seventh);
    assert.strictEqual(res.status, 401, 'its predecessor cannot bring the session back');
    console.log('ok - signing out ends it');

    // 6. Revoking every session (password reset, account switched off) wins.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const a = res.json.data.refreshToken;
    res = await renew(a);
    const b = res.json.data.refreshToken;
    await RefreshToken.updateMany({ userId: user._id, isRevoked: false }, { isRevoked: true });
    assert.strictEqual((await renew(b)).status, 401);
    assert.strictEqual((await renew(a)).status, 401, 'a lost-reply recovery cannot undo a revoke-all');
    console.log('ok - revoking all sessions still signs out');

    // 7. Two renewals with the same token at the same moment: only one
    //    succeeds as a normal renewal; the phone's single request is safe.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const c = res.json.data.refreshToken;
    const results = await Promise.all([renew(c), renew(c)]);
    assert.ok(results.some((r) => r.status === 200), 'at least one renewal works');
    console.log('ok - simultaneous renewals do not crash');

    console.log('sessionRenewal.test.js: all checks passed');
  } finally {
    await RefreshToken.deleteMany({ userId: { $in: made } });
    await User.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
