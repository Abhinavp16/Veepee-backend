const assert = require('assert');

// Saved delivery addresses live on the account, so they come back after
// signing in on any phone.
//
//   ADDRESS_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_address_test?replicaSet=rs0' node tests/savedAddresses.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.ADDRESS_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set ADDRESS_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: ADDRESS_TEST_MONGODB_URI must point at a database on this machine');
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
  const { User, AccountDeletionRequest } = require('../src/models');

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
  const made = [];
  const makeUser = async () => {
    const user = await User.create({ name: 'Addr', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'buyer' });
    made.push(user._id);
    return { user, token: jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
  };
  const home = {
    id: 'addr-home', slot: 'primary', fullName: 'Asha', phone: '9812345670',
    addressLine1: '12 MG Road', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001',
  };
  const shop = { ...home, id: 'addr-shop', slot: 'secondary', addressLine1: '5 Station Road', city: 'Durg', pincode: '491001' };

  try {
    const asha = await makeUser();
    const ravi = await makeUser();

    let res = await call('GET', '/auth/addresses');
    assert.strictEqual(res.status, 401, 'needs sign-in');

    res = await call('GET', '/auth/addresses', { token: asha.token });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.data.addresses, [], 'a new account has none');
    assert.strictEqual(res.json.data.selectedAddressId, null);

    res = await call('PUT', '/auth/addresses', { token: asha.token, body: { addresses: [home, shop], selectedAddressId: 'addr-shop' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.data.addresses.length, 2);
    assert.strictEqual(res.json.data.selectedAddressId, 'addr-shop');

    // Read back, as a sign-in on another phone would.
    res = await call('GET', '/auth/addresses', { token: asha.token });
    assert.deepStrictEqual(res.json.data.addresses.map((a) => a.id), ['addr-home', 'addr-shop']);
    assert.strictEqual(res.json.data.addresses[1].city, 'Durg');
    assert.strictEqual(res.json.data.selectedAddressId, 'addr-shop');

    // Another account sees only its own.
    res = await call('GET', '/auth/addresses', { token: ravi.token });
    assert.deepStrictEqual(res.json.data.addresses, []);

    // Addresses are not sent with the profile.
    res = await call('GET', '/auth/me', { token: asha.token });
    assert.strictEqual(res.json.data.savedAddresses, undefined);

    // Validation.
    const bad = async (addresses, message) => {
      const r = await call('PUT', '/auth/addresses', { token: asha.token, body: { addresses } });
      assert.strictEqual(r.status, 400, message);
    };
    await bad([{ ...home, pincode: '123' }], 'pincode must be 6 digits');
    await bad([{ ...home, pincode: 'Durg49' }], 'pincode must be digits');
    await bad([{ ...home, phone: '12345' }], 'phone must be 10 digits');
    await bad([{ ...home, city: '' }], 'city is required');
    await bad([home, { ...shop, slot: 'primary' }], 'one address per slot');
    await bad([home, shop, { ...shop, id: 'third' }], 'at most two');

    // A selected id that is not in the list falls back to the first address.
    res = await call('PUT', '/auth/addresses', { token: asha.token, body: { addresses: [home], selectedAddressId: 'gone' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.data.selectedAddressId, 'addr-home');

    // Clearing all addresses.
    res = await call('PUT', '/auth/addresses', { token: asha.token, body: { addresses: [] } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.data.addresses, []);
    assert.strictEqual(res.json.data.selectedAddressId, null);

    // Account deletion removes them.
    await call('PUT', '/auth/addresses', { token: asha.token, body: { addresses: [home] } });
    // Uploaded-file cleanup needs Firebase; not part of this check.
    const storageCleanup = require('../src/utils/storageCleanup');
    storageCleanup.deleteByPrefix = async () => true;
    storageCleanup.deleteFile = async () => true;
    const deletion = require('../src/services/accountDeletionService');
    const { request } = await deletion.createRequestForUser({ user: asha.user, source: 'app' });
    const admin = await User.create({ name: 'Admin', phone: randomPhone(), passwordHash: 'secret123', authProvider: 'email', role: 'admin' });
    made.push(admin._id);
    await deletion.completeRequest({ requestId: request._id, adminUserId: admin._id, identityVerified: true });
    const after = await User.findById(asha.user._id).select('+savedAddresses +selectedAddressId');
    assert.strictEqual(after.savedAddresses.length, 0, 'deleted accounts keep no addresses');
    assert.strictEqual(after.selectedAddressId, null);

    console.log('savedAddresses.test.js: all checks passed');
  } finally {
    await User.deleteMany({ _id: { $in: made } });
    await AccountDeletionRequest.deleteMany({ userId: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
