const assert = require('assert');

// Forgot password, through OXON support: the customer asks from the app,
// then an admin issues a one-time password (24 hours); the customer is
// signed out everywhere, signs in with it, can do nothing but choose a new
// password, and then signs in with the new one.
//
//   PASSWORD_RESET_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_password_reset_test?replicaSet=rs0' node tests/customerPasswordReset.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.PASSWORD_RESET_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set PASSWORD_RESET_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: PASSWORD_RESET_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

const randomPhone = () => {
  for (;;) {
    const candidate = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    if (!/^(\d)\1+$/.test(candidate) && new Set(candidate).size > 4) return candidate;
  }
};

async function run() {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const M = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const made = [];

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const codeOf = (res) => res.json.error?.code || res.json.code;
  const tokenFor = (user) => jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  // A still-valid access token issued a minute ago (another phone's sign-in).
  const earlierTokenFor = (user) => jwt.sign(
    { userId: user._id, iat: Math.floor(Date.now() / 1000) - 60 },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  try {
    const admin = await M.User.create({ name: 'PR admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    const staff = await M.User.create({ name: 'PR staff', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'staff' });
    const phone = randomPhone();
    const email = `pr-${phone}@example.com`;
    const buyer = await M.User.create({ name: 'PR buyer', phone, email, passwordHash: 'OldPass@123', authProvider: 'email', role: 'buyer' });
    const wholesaler = await M.User.create({ name: 'PR wholesaler', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'wholesaler' });
    const removed = await M.User.create({ name: 'PR removed', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'buyer', deletedAt: new Date() });
    made.push(admin._id, staff._id, buyer._id, wholesaler._id, removed._id);
    const login = (password) => call('POST', '/auth/login-phone', null, { phone, password });
    const resetBuyer = () => call('POST', `/admin/customers/${buyer._id}/reset-password`, tokenFor(admin));
    const askForReset = (number) => call('POST', '/auth/forgot-password', null, { phone: number });
    // As if the customer had asked from the app just now.
    const markAsked = (user) => M.PasswordResetRequest.create({ userId: user._id, name: user.name, phone: user.phone });
    const listRequests = (status, token = tokenFor(admin)) =>
      call('GET', `/admin/password-reset-requests?status=${status}`, token);
    const buyerRows = (res) => res.json.data.filter((row) => row.phone === phone);
    // The alert is saved in the background; give it a moment.
    const alertsFor = async (number) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return M.AdminNotification.countDocuments({ type: 'password_reset_request', body: new RegExp(number) });
    };

    // A session from before the reset.
    let res = await login('OldPass@123');
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const oldRefresh = res.json.data.refreshToken;
    const oldAccess = earlierTokenFor(buyer);
    assert.strictEqual((await call('GET', '/cart', oldAccess)).status, 200);

    // 1. Admins only.
    res = await call('POST', `/admin/customers/${buyer._id}/reset-password`, tokenFor(staff));
    assert.strictEqual(res.status, 403);
    res = await call('POST', `/admin/customers/${buyer._id}/reset-password`, tokenFor(wholesaler));
    assert.strictEqual(res.status, 403, 'customers cannot reset anyone');
    res = await call('POST', `/admin/customers/${buyer._id}/reset-password`);
    assert.strictEqual(res.status, 401);
    res = await call('POST', `/admin/customers/${admin._id}/reset-password`, tokenFor(admin));
    assert.strictEqual(res.status, 404, 'staff and admin accounts are not customers');
    res = await call('POST', `/admin/customers/${removed._id}/reset-password`, tokenFor(admin));
    assert.strictEqual(res.status, 404, 'removed accounts are not reset');
    await markAsked(wholesaler);
    res = await call('POST', `/admin/customers/${wholesaler._id}/reset-password`, tokenFor(admin));
    assert.strictEqual(res.status, 200, 'wholesalers can be reset');
    console.log('ok - admins only, customers only (buyers and wholesalers)');

    // 2. Only after the customer asks from the app (Forgot Password).
    assert.strictEqual(codeOf(await resetBuyer()), 'NO_RESET_REQUEST', 'no reset without a request');
    const unknown = randomPhone();
    res = await askForReset(unknown);
    assert.strictEqual(res.status, 200);
    const answer = res.json.message;
    res = await askForReset(phone);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.message, answer, 'no hint whether the number has an account');
    assert.strictEqual(await alertsFor(phone), 1, 'admin is alerted');
    assert.strictEqual(await alertsFor(unknown), 0);
    await askForReset(phone);
    assert.strictEqual(await alertsFor(phone), 1, 'asking again the same day alerts once');
    res = await listRequests('open');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(buyerRows(res).length, 1, 'one open request, however often they ask that day');
    assert.strictEqual(buyerRows(res)[0].status, 'open');
    assert.strictEqual(buyerRows(res)[0].customerId, String(buyer._id));
    assert.ok(res.json.summary.open >= 1);
    assert.strictEqual((await listRequests('open', tokenFor(staff))).status, 403, 'admins only');
    res = await call('GET', `/admin/customers/${buyer._id}`, tokenFor(admin));
    assert.ok(res.json.data.passwordResetRequestedAt, 'the customer page shows the open request');
    assert.strictEqual((await askForReset('12345')).status, 400, 'a phone number is needed');
    console.log('ok - the customer asks from the app; admin is alerted once');

    // 3. Reset: a one-time password for 24 hours; old sessions end.
    res = await resetBuyer();
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const temp = res.json.data.temporaryPassword;
    assert.strictEqual(codeOf(await resetBuyer()), 'NO_RESET_REQUEST', 'one reset per request');
    assert.strictEqual(buyerRows(await listRequests('open')).length, 0);
    const done = buyerRows(await listRequests('completed'));
    assert.strictEqual(done[0].completedByName, 'PR admin', 'the list shows who reset it');
    const history = buyerRows(await listRequests('history'));
    assert.strictEqual(history.length, 1, 'history has the finished request');
    assert.ok(history[0].requestedAt && history[0].completedAt, 'when asked and when reset');
    assert.ok(new Date(history[0].completedAt) >= new Date(history[0].lastRequestedAt));
    const profile = (await call('GET', `/admin/customers/${buyer._id}`, tokenFor(admin))).json.data;
    assert.strictEqual(profile.passwordResetRequests[0].status, 'completed', 'the customer page shows it too');
    assert.strictEqual(profile.passwordResetRequests[0].customerId, String(buyer._id));
    assert.strictEqual(profile.passwordResetRequestedAt, null, 'nothing open after the reset');
    assert.ok(/^OX-\d{4}-\d{4}$/.test(temp), temp);
    const hours = (new Date(res.json.data.expiresAt) - Date.now()) / 3600000;
    assert.ok(hours > 23.9 && hours <= 24, String(hours));
    assert.strictEqual(res.json.data.passwordResets[0].byName, 'PR admin');
    res = await call('POST', '/auth/refresh-token', null, { refreshToken: oldRefresh });
    assert.strictEqual(res.status, 401, 'old sessions signed out');
    res = await call('GET', '/cart', oldAccess);
    assert.strictEqual(codeOf(res), 'PASSWORD_CHANGED', 'old access tokens stop working at once');
    assert.strictEqual((await login('OldPass@123')).status, 401, 'old password no longer works');
    const note = await M.Notification.findOne({ userId: buyer._id }).lean();
    assert.ok(note && note.title === 'Your password was reset');
    console.log('ok - one-time password issued; signed out everywhere; customer told');

    // 4. Signing in with it (any case or spacing): only choosing a new
    // password is allowed.
    assert.strictEqual((await login(temp.toLowerCase())).status, 200, 'lower case works');
    assert.strictEqual((await login(temp.replace(/\D/g, ''))).status, 200, 'digits only work');
    res = await login(temp);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.user.mustChangePassword, true);
    assert.strictEqual(res.json.data.user.passwordResets, undefined, 'history stays with admin');
    const tempToken = res.json.data.accessToken;
    res = await call('GET', '/cart', tempToken);
    assert.strictEqual(codeOf(res), 'PASSWORD_CHANGE_REQUIRED');
    console.log('ok - signed in with it, must choose a new password first');

    // 5. New password: works, the one-time password doesn't.
    res = await call('POST', '/auth/change-password', tempToken, { currentPassword: temp, newPassword: 'NewPass@456' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.user.mustChangePassword, false);
    assert.strictEqual((await call('GET', '/cart', res.json.data.accessToken)).status, 200, 'this phone carries on');
    assert.strictEqual(codeOf(await call('GET', '/cart', earlierTokenFor(buyer))), 'PASSWORD_CHANGED', 'other phones are signed out');
    assert.strictEqual((await login(temp)).status, 401, 'one-time password stops working');
    res = await login('NewPass@456');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await call('GET', '/cart', res.json.data.accessToken)).status, 200);
    const saved = await M.User.findById(buyer._id).lean();
    assert.strictEqual(saved.tempPasswordExpiresAt, null);
    console.log('ok - new password set; one-time password no longer works');

    // 6. Expired after 24 hours: at sign-in (phone or email) and when
    // choosing the new password.
    await markAsked(buyer);
    res = await resetBuyer();
    const temp2 = res.json.data.temporaryPassword;
    res = await login(temp2);
    const temp2Token = res.json.data.accessToken;
    await M.User.updateOne({ _id: buyer._id }, { $set: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } });
    assert.strictEqual(codeOf(await login(temp2)), 'TEMP_PASSWORD_EXPIRED');
    assert.strictEqual(codeOf(await call('POST', '/auth/login', null, { email, password: temp2 })), 'TEMP_PASSWORD_EXPIRED');
    res = await call('POST', '/auth/change-password', temp2Token, { currentPassword: temp2, newPassword: 'Later@789' });
    assert.strictEqual(codeOf(res), 'TEMP_PASSWORD_EXPIRED');
    res = await call('GET', `/admin/customers/${buyer._id}`, tokenFor(admin));
    assert.strictEqual(res.json.data.passwordResets.length, 2, 'admin sees every reset');
    console.log('ok - expires after 24 hours, also mid-session; admin sees the history');

    // 7. Five wrong tries and it stops working, even typed right.
    await markAsked(buyer);
    res = await resetBuyer();
    const temp3 = res.json.data.temporaryPassword;
    const wrong = temp3 === 'OX-0000-0000' ? 'OX-0000-0001' : 'OX-0000-0000';
    for (let i = 0; i < 5; i += 1) assert.strictEqual(codeOf(await login(wrong)), 'AUTH_INVALID_CREDENTIALS');
    assert.strictEqual(codeOf(await login(temp3)), 'TEMP_PASSWORD_EXPIRED');
    await markAsked(buyer);
    res = await resetBuyer();
    assert.strictEqual((await login(res.json.data.temporaryPassword)).status, 200, 'a new reset starts the count again');
    assert.strictEqual((await M.User.findById(buyer._id).lean()).tempPasswordFailures, 0);
    console.log('ok - stops after 5 wrong tries; a new reset works');

    // 8. A request is good for 24 hours; requests are limited.
    const lapsed = await markAsked(buyer);
    await M.PasswordResetRequest.updateOne({ _id: lapsed._id }, { $set: { lastRequestedAt: new Date(Date.now() - 25 * 3600000) } });
    assert.strictEqual(codeOf(await resetBuyer()), 'NO_RESET_REQUEST', 'a day-old request has lapsed');
    assert.ok(buyerRows(await listRequests('expired')).some((row) => row._id === String(lapsed._id)), 'listed as expired');
    assert.ok(buyerRows(await listRequests('history')).some((row) => row._id === String(lapsed._id) && row.status === 'expired'),
      'and in the history');
    const busy = randomPhone();
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await askForReset(busy)).status, 200);
    assert.strictEqual((await askForReset(busy)).status, 429, '3 requests an hour per number');
    console.log('ok - a request lasts 24 hours; requests are limited');
  } finally {
    await M.Notification.deleteMany({ userId: { $in: made } });
    await M.AdminNotification.deleteMany({ type: 'password_reset_request' });
    await M.PasswordResetRequest.deleteMany({});
    await M.RefreshToken.deleteMany({ userId: { $in: made } });
    await M.User.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => {
  console.log('PASS customerPasswordReset');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
