const assert = require('assert');

// Rate limits: generous for normal use, strict only on sign-in style routes.
//   node tests/rateLimits.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';

async function run() {
  const http = require('http');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { clientIp, createApiLimiter, createAuthLimiter } = require('../src/middlewares/rateLimits');

  const app = express();
  app.use(express.json());
  // Sign-in limits are checked on their own (before the small test API limit).
  const auth = createAuthLimiter({ perIdentity: 3, perIp: 6, windowMs: 15 * 60 * 1000 });
  app.post('/api/v1/auth/login-phone', auth, (req, res) => {
    if (req.body.password === 'right') return res.json({ success: true });
    return res.status(401).json({ success: false });
  });
  app.use('/api', createApiLimiter({ max: 5, windowMs: 60 * 1000 }));
  app.get('/api/v1/health', (req, res) => res.json({ ok: true }));
  app.get('/api/v1/internal/cron/daily', (req, res) => res.json({ ok: true }));
  app.get('/api/v1/products', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (path, { ip = '1.1.1.1', token, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-vercel-forwarded-for': ip,
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  };
  const tokenFor = (userId, secret = process.env.JWT_SECRET) => jwt.sign({ userId }, secret, { expiresIn: '10m' });

  try {
    // Client address: Vercel's header first, then the first forwarded address.
    assert.strictEqual(clientIp({ headers: { 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' } }), '9.9.9.9');
    assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' } }), '8.8.8.8');
    assert.strictEqual(clientIp({ headers: {}, ip: '7.7.7.7' }), '7.7.7.7');

    // Guests are counted per device address, not all together.
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await call('/products', { ip: '2.2.2.2' })).status, 200);
    const blocked = await call('/products', { ip: '2.2.2.2' });
    assert.strictEqual(blocked.status, 429, 'the 6th request in the window is refused');
    assert.strictEqual(blocked.json.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(Number(blocked.retryAfter) > 0, 'tells the app when to retry');
    assert.strictEqual((await call('/products', { ip: '3.3.3.3' })).status, 200, 'another device is unaffected');

    // Signed-in users get their own budget, even on a shared address.
    const asha = tokenFor('asha');
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await call('/products', { ip: '2.2.2.2', token: asha })).status, 200);
    assert.strictEqual((await call('/products', { ip: '2.2.2.2', token: asha })).status, 429);
    assert.strictEqual((await call('/products', { ip: '2.2.2.2', token: tokenFor('ravi') })).status, 200);

    // A forged token does not buy a fresh budget: it counts against the address.
    const forged = tokenFor('someone-else', 'not-the-real-secret');
    assert.strictEqual((await call('/products', { ip: '2.2.2.2', token: forged })).status, 429);

    // Health checks and the daily job are never limited.
    for (let i = 0; i < 8; i += 1) {
      assert.strictEqual((await call('/health', { ip: '4.4.4.4' })).status, 200);
      assert.strictEqual((await call('/internal/cron/daily', { ip: '4.4.4.4' })).status, 200);
    }

    // Sign-in: wrong passwords are limited per phone, right ones are not counted.
    const login = (phone, password, ip = '5.5.5.5') =>
      call('/auth/login-phone', { ip, method: 'POST', body: { phone, password } });
    for (let i = 0; i < 10; i += 1) assert.strictEqual((await login('9000000001', 'right')).status, 200);
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await login('9000000002', 'wrong')).status, 401);
    const guessed = await login('9000000002', 'right');
    assert.strictEqual(guessed.status, 429, 'after 3 wrong passwords the phone is paused');
    assert.ok(Number(guessed.retryAfter) > 0);
    assert.strictEqual((await login('9000000002', 'right', '6.6.6.6')).status, 429, 'changing device does not reset a phone');

    // One address cannot try many phones.
    for (let i = 0; i < 6; i += 1) await login(`90000001${i}0`, 'wrong', '7.7.7.7');
    assert.strictEqual((await login('9000000199', 'wrong', '7.7.7.7')).status, 429, 'per-address cap');

    console.log('rateLimits.test.js: all checks passed');
  } finally {
    server.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
