const assert = require('assert');

// The public offer list (app and website) only shows offers that are running
// now: not ones that ended or haven't started.
//
//   OFFERS_TEST_MONGODB_URI='mongodb://127.0.0.1:27233/oxon_offers_test?replicaSet=rs0' node tests/publicOffers.test.js

process.env.JWT_SECRET = 'test-access-secret-0123456789-abcdefghij';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIREBASE_CLIENT_EMAIL;

const uri = process.env.OFFERS_TEST_MONGODB_URI;
if (!uri) {
  console.log('SKIP: set OFFERS_TEST_MONGODB_URI to a local MongoDB to run this test');
  process.exit(0);
}
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(uri)) {
  console.error('Refusing to run: OFFERS_TEST_MONGODB_URI must point at a database on this machine');
  process.exit(1);
}
process.env.MONGODB_URI = uri;

async function run() {
  const http = require('http');
  const mongoose = require('mongoose');
  const app = require('../src/app');
  const connectDB = require('../src/config/database');
  const { Offer } = require('../src/models');

  await connectDB();
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now().toString(36).toUpperCase();
  const day = 24 * 60 * 60 * 1000;
  const made = [];

  try {
    const make = async (name, extra) => {
      const offer = await Offer.create({ title: `${name} ${suffix}`, discountType: 'percentage', discountValue: 10, code: `${name}${suffix}`, targetGroup: 'buyer', ...extra });
      made.push(offer._id);
      return offer;
    };
    await make('RUNNING', { startDate: new Date(Date.now() - day), endDate: new Date(Date.now() + day) });
    await make('NOEND', { startDate: new Date(Date.now() - day) });
    await make('ENDED', { startDate: new Date(Date.now() - 10 * day), endDate: new Date(Date.now() - day) });
    await make('LATER', { startDate: new Date(Date.now() + day) });
    await make('OFF', { startDate: new Date(Date.now() - day), isActive: false });

    const res = await fetch(`${base}/offers?targetGroup=buyer`);
    const json = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(json));
    const codes = json.data.map((offer) => offer.code).filter((code) => code?.endsWith(suffix)).sort();
    assert.deepStrictEqual(codes, [`NOEND${suffix}`, `RUNNING${suffix}`]);
    console.log('1. only running offers are listed (ended, not started and turned-off ones are hidden)');

    console.log('All public offer tests passed');
  } finally {
    await Offer.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
