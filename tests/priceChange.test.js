const assert = require('assert');
const { __test } = require('../src/services/priceLifecycleService');
const cronAuth = require('../src/middlewares/cronAuth');

let passed = 0;
let failed = 0;
function check(description, fn) {
  try {
    fn();
    console.log(`PASS: ${description}`);
    passed++;
  } catch (error) {
    console.error(`FAIL: ${description}\n  ${error.message}`);
    failed++;
  }
}
const throwsCode = (fn, code) => assert.throws(fn, (error) => error.code === code);

const product = { retailPrice: 700, wholesalePrice: 600, mrp: 1000 };

check('accepts an MRP-only change', () => {
  assert.deepStrictEqual(__test.submittedPrices({ mrp: 1200 }), { mrp: 1200 });
});
check('accepts retail + wholesale + mrp together', () => {
  assert.deepStrictEqual(
    __test.submittedPrices({ retailPrice: 710, wholesalePrice: 610, mrp: 1100 }),
    { retailPrice: 710, wholesalePrice: 610, mrp: 1100 }
  );
});
check('rejects an empty submission', () => {
  throwsCode(() => __test.submittedPrices({}), 'PRICE_REQUIRED');
});
check('rejects negative prices', () => {
  throwsCode(() => __test.submittedPrices({ mrp: -1 }), 'INVALID_PRICE');
});
check('rejects an unchanged MRP', () => {
  throwsCode(() => __test.assertSubmittedPricesChange(product, { mrp: 1000 }), 'UNCHANGED_PRICE');
});
check('accepts an MRP that differs from the current one', () => {
  __test.assertSubmittedPricesChange(product, { mrp: 1100 });
});
check('rejects MRP below the current retail price', () => {
  throwsCode(() => __test.assertMrpNotBelowRetail(product, { mrp: 650 }), 'MRP_BELOW_RETAIL');
});
check('rejects MRP below the retail price in the same request', () => {
  throwsCode(() => __test.assertMrpNotBelowRetail(product, { mrp: 900, retailPrice: 950 }), 'MRP_BELOW_RETAIL');
});
check('does not block retail-only changes (legacy data)', () => {
  __test.assertMrpNotBelowRetail({ retailPrice: 700, mrp: 500 }, { retailPrice: 650 });
});
check('fingerprint differs when only the MRP differs', () => {
  assert.notStrictEqual(
    __test.requestFingerprint({ mrp: 1100 }, 'immediate'),
    __test.requestFingerprint({ mrp: 1200 }, 'immediate')
  );
});
check('clearing a pending change also clears the pending MRP', () => {
  assert.strictEqual(__test.clearPendingPriceChange().pendingMrp, null);
});

function runCron(authorization, secret) {
  const previous = process.env.CRON_SECRET;
  if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  let outcome;
  cronAuth({ get: () => authorization }, {}, (error) => { outcome = error || 'next'; });
  if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
  return outcome;
}
check('cron: 503 when CRON_SECRET is not configured', () => {
  assert.strictEqual(runCron('Bearer x', undefined).statusCode, 503);
});
check('cron: 401 without the header', () => {
  assert.strictEqual(runCron(undefined, 's3cret').statusCode, 401);
});
check('cron: 401 with a wrong secret', () => {
  assert.strictEqual(runCron('Bearer nope!!', 's3cret').statusCode, 401);
});
check('cron: passes with the correct secret', () => {
  assert.strictEqual(runCron('Bearer s3cret', 's3cret'), 'next');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
