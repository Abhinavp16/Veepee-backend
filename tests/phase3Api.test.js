const assert = require('assert');

// Phase 3 API behaviour against a real local database: the 6-hour staff
// session, forced password change and admin password reset.
//
//   PHASE3_TEST_MONGODB_URI=mongodb://127.0.0.1:27231/oxon_phase3_test node tests/phase3Api.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PHASE3_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PHASE3_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PHASE3_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { User, RefreshToken, Company } = require('../src/models');
  const { tokenExpiry, toSeconds } = require('../src/utils/sessionTokens');

  // Pure helpers.
  assert.strictEqual(toSeconds('15m'), 900);
  assert.strictEqual(toSeconds('7d'), 604800);
  assert.strictEqual(toSeconds('nonsense', 42), 42);
  assert.strictEqual(tokenExpiry(900, null, 1000), 1900);
  assert.strictEqual(tokenExpiry(900, 1500, 1000), 1500, 'capped by the session end');
  assert.strictEqual(tokenExpiry(900, 99999, 1000), 1900, 'session end further away than the token');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;

  const suffix = Date.now().toString(36);
  const email = `staff-${suffix}@example.com`;
  const adminEmail = `admin-${suffix}@example.com`;
  const made = { users: [], companies: [] };

  try {
    const admin = await User.create({ name: 'P3 Admin', email: adminEmail, passwordHash: 'adminpass123', authProvider: 'email', role: 'admin' });
    made.users.push(admin._id);
    let res = await call('POST', '/auth/login', { body: { email: adminEmail, password: 'adminpass123' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.sessionExpiresAt, undefined, 'admin sessions are not capped');
    const adminToken = res.json.data.accessToken;

    // Admin creates a staff account with an initial password.
    res = await call('POST', '/admin/staff', { token: adminToken, body: { name: 'P3 Staff', email, password: 'firstpass123' } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const staffId = res.json.data._id;
    made.users.push(staffId);
    assert.strictEqual(res.json.data.mustChangePassword, true);

    // Shared logins turn staff away; the staff login accepts them.
    res = await call('POST', '/auth/login', { body: { email, password: 'firstpass123' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(codeOf(res), 'STAFF_LOGIN_REQUIRED');
    res = await call('POST', '/auth/staff-login', { body: { email, password: 'wrong-password' } });
    assert.strictEqual(res.status, 401);
    res = await call('POST', '/auth/staff-login', { body: { email: adminEmail, password: 'adminpass123' } });
    assert.strictEqual(res.status, 401, 'admins do not use the staff login');

    const before = Date.now();
    res = await call('POST', '/auth/staff-login', { body: { email, password: 'firstpass123' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const sessionEnd = new Date(res.json.data.sessionExpiresAt).getTime();
    assert.ok(Math.abs(sessionEnd - (before + 6 * 3600 * 1000)) < 5000, 'session lasts 6 hours');
    let { accessToken, refreshToken } = res.json.data;
    const access = jwt.decode(accessToken);
    assert.strictEqual(access.sx * 1000, Math.floor(sessionEnd / 1000) * 1000);
    assert.ok(access.exp <= access.sx);
    assert.ok(jwt.decode(refreshToken).exp <= access.sx, 'refresh token ends with the session');
    assert.strictEqual(res.json.data.user.mustChangePassword, true);

    // A temporary password only allows changing it.
    res = await call('GET', '/admin/orders', { token: accessToken });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(codeOf(res), 'PASSWORD_CHANGE_REQUIRED');
    res = await call('GET', '/auth/me', { token: accessToken });
    assert.strictEqual(res.status, 200);

    res = await call('POST', '/auth/change-password', { token: accessToken, body: { currentPassword: 'nope-nope-1', newPassword: 'secondpass123' } });
    assert.strictEqual(res.status, 401);
    res = await call('POST', '/auth/change-password', { token: accessToken, body: { currentPassword: 'firstpass123', newPassword: 'firstpass123' } });
    assert.strictEqual(res.status, 400, 'must be a different password');
    res = await call('POST', '/auth/change-password', { token: accessToken, body: { currentPassword: 'firstpass123', newPassword: 'secondpass123' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(jwt.decode(res.json.data.accessToken).sx, access.sx, 'the session end does not move');
    assert.strictEqual(res.json.data.user.mustChangePassword, false);
    const oldRefresh = refreshToken;
    ({ accessToken, refreshToken } = res.json.data);

    res = await call('POST', '/auth/refresh-token', { body: { refreshToken: oldRefresh } });
    assert.strictEqual(res.status, 401, 'sessions from before the change are ended');
    res = await call('GET', '/admin/orders', { token: accessToken });
    assert.strictEqual(res.status, 200, 'staff can work once the password is theirs');

    // Refresh keeps the original end.
    res = await call('POST', '/auth/refresh-token', { body: { refreshToken } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(jwt.decode(res.json.data.accessToken).sx, access.sx);
    assert.strictEqual(Math.floor(new Date(res.json.data.sessionExpiresAt).getTime() / 1000), Math.floor(sessionEnd / 1000));
    const rotated = res.json.data;

    // A refresh token cannot be used as an access token.
    res = await call('GET', '/auth/me', { token: rotated.refreshToken });
    assert.strictEqual(res.status, 401);

    // Once the session end passes, nothing renews it.
    await RefreshToken.updateOne({ token: rotated.refreshToken }, { $set: { sessionExpiresAt: new Date(Date.now() - 1000) } });
    res = await call('POST', '/auth/refresh-token', { body: { refreshToken: rotated.refreshToken } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(codeOf(res), 'SESSION_EXPIRED');
    const expiredAccess = jwt.sign({ userId: staffId, sx: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res = await call('GET', '/auth/me', { token: expiredAccess });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(codeOf(res), 'SESSION_EXPIRED');

    // Old staff tokens with no recorded end cannot be refreshed.
    const legacy = jwt.sign({ userId: staffId, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await RefreshToken.create({ userId: staffId, token: legacy, expiresAt: new Date(Date.now() + 86400000) });
    res = await call('POST', '/auth/refresh-token', { body: { refreshToken: legacy } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(codeOf(res), 'SESSION_EXPIRED');

    // Admin resets the password: new temporary password, sessions revoked.
    res = await call('POST', '/auth/staff-login', { body: { email, password: 'secondpass123' } });
    const liveRefresh = res.json.data.refreshToken;
    res = await call('POST', `/admin/staff/${staffId}/reset-password`, { token: adminToken });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const temp = res.json.data.temporaryPassword;
    assert.ok(temp && temp.length >= 12);
    res = await call('POST', '/auth/refresh-token', { body: { refreshToken: liveRefresh } });
    assert.strictEqual(res.status, 401, 'reset ends current sessions');
    res = await call('POST', '/auth/staff-login', { body: { email, password: 'secondpass123' } });
    assert.strictEqual(res.status, 401, 'old password no longer works');
    res = await call('POST', '/auth/staff-login', { body: { email, password: temp } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.user.mustChangePassword, true);

    // Only admins can reset.
    res = await call('POST', `/admin/staff/${staffId}/reset-password`, { token: res.json.data.accessToken });
    assert.strictEqual(res.status, 403);

    // Deactivated staff cannot sign in.
    await call('PATCH', `/admin/staff/${staffId}`, { token: adminToken, body: { isActive: false } });
    res = await call('POST', '/auth/staff-login', { body: { email, password: temp } });
    assert.strictEqual(res.status, 401);

    // --- Brand ordering --------------------------------------------------------
    const names = ['Zeta', 'Alpha', 'Mid'].map((n) => `P3 ${n} ${suffix}`);
    const brands = [];
    for (const name of names) {
      res = await call('POST', '/companies', { token: adminToken, body: { name } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.json));
      brands.push(res.json.data._id);
      made.companies.push(res.json.data._id);
    }
    const listOrder = async () => {
      const r = await call('GET', '/companies?limit=100');
      return r.json.data.filter((c) => brands.includes(String(c._id))).map((c) => c.name);
    };
    assert.deepStrictEqual(await listOrder(), names, 'new brands go to the end in creation order');

    res = await call('PATCH', '/companies/reorder', { token: adminToken, body: { ids: [brands[1], brands[2], brands[0]] } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.deepStrictEqual(await listOrder(), [names[1], names[2], names[0]]);
    res = await call('PATCH', '/companies/reorder', { token: adminToken, body: { ids: [brands[0], brands[0]] } });
    assert.strictEqual(res.status, 400, 'duplicates are rejected');
    res = await call('PATCH', '/companies/reorder', { token: adminToken, body: { ids: [brands[0], '6acce1f3fc46a0c2e2bad197'] } });
    assert.strictEqual(res.status, 404, 'unknown brands are rejected');
    const nobody = await call('PATCH', '/companies/reorder', { body: { ids: [brands[0]] } });
    assert.strictEqual(nobody.status, 401);

    console.log('phase3 api tests passed');
  } finally {
    await RefreshToken.deleteMany({ userId: { $in: made.users } });
    await Company.deleteMany({ _id: { $in: made.companies } });
    await User.deleteMany({ _id: { $in: made.users } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
