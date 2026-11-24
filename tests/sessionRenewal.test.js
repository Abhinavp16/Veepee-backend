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
    assert.ok(res.json.data.refreshToken !== third);
    // Lost again: still recovered while the newest one is unused. (The
    // phone never had `third` or `fourth`; presenting those cancelled ones
    // would mean a copy, tested in step 9.)
    res = await renew(second);
    assert.strictEqual(res.status, 200, 'a second lost reply is recovered too');
    const fifth = res.json.data.refreshToken;
    console.log('ok - a lost reply does not sign the person out');

    // 4. Once the new token has been used, the old one is refused (a copy).
    res = await renew(fifth);
    assert.strictEqual(res.status, 200);
    const sixth = res.json.data.refreshToken;
    res = await renew(second);
    assert.strictEqual(res.status, 401, 'an old token after its replacement was used is refused');
    res = await renew(sixth);
    assert.strictEqual(res.status, 401, 'and, being a copy, it ends every session');
    console.log('ok - a token copied and used later is refused');

    // 5. Signing out ends it for good, even for an earlier token.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const seventh = res.json.data.refreshToken;
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

    // 7. Two renewals with the same token at the same moment (the app killed
    //    and reopened mid-request): neither signs the person out.
    for (let i = 0; i < 10; i += 1) {
      res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
      const c = res.json.data.refreshToken;
      const results = await Promise.all([renew(c), renew(c)]);
      assert.deepStrictEqual(results.map((r) => r.status), [200, 200], `round ${i}: ${JSON.stringify(results.map((r) => r.json))}`);
      // The phone keeps the last reply it saw; it works.
      assert.strictEqual((await renew(results[1].json.data.refreshToken)).status, 200);
    }
    console.log('ok - simultaneous renewals never sign the person out');

    // 8. Signing out after the app renewed just before (stale access token):
    //    the phone sends its older renewal token, yet nothing it was swapped
    //    for can bring the session back.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const r1 = res.json.data.refreshToken;
    res = await renew(r1);
    const pair2 = res.json.data;
    res = await call('POST', '/auth/logout', { refreshToken: r1 }, pair2.accessToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await renew(pair2.refreshToken)).status, 401, 'the newer token is signed out too');
    assert.strictEqual((await renew(r1)).status, 401, 'and the older one cannot recover the session');
    // A lost reply, then sign out with the old token: the unused one ends too.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const s1 = res.json.data;
    const s2 = (await renew(s1.refreshToken)).json.data; // reply "lost"
    res = await call('POST', '/auth/logout', { refreshToken: s1.refreshToken }, s1.accessToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await renew(s2.refreshToken)).status, 401);
    assert.strictEqual((await renew(s1.refreshToken)).status, 401);
    console.log('ok - signing out ends every token of that sign-in');

    // 9. A copy: someone with the old token renews while the real phone's new
    //    token is unused. When the real phone then uses its (cancelled) token,
    //    every session of the account ends, the copy's included.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const t1 = res.json.data.refreshToken;
    const t2 = (await renew(t1)).json.data.refreshToken; // the real phone has t2
    const stolen = (await renew(t1)).json.data.refreshToken; // the copy
    res = await renew(t2);
    assert.strictEqual(res.status, 401, 'the cancelled token is refused');
    assert.strictEqual((await renew(stolen)).status, 401, 'and the copy is signed out too');
    // Using the old token after its replacement was used also ends everything.
    res = await call('POST', '/auth/login-phone', { phone, password: 'Buyer@123' });
    const u1 = res.json.data.refreshToken;
    const u2 = (await renew(u1)).json.data.refreshToken;
    const u3 = (await renew(u2)).json.data.refreshToken; // u2 used
    assert.strictEqual((await renew(u1)).status, 401);
    assert.strictEqual((await renew(u3)).status, 401, 'a reused old token ends every session');
    console.log('ok - a copied token ends all sessions instead of taking one over');

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
