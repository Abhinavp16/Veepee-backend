const assert = require('assert');
const http = require('http');

const { TEMPLATES, renderTemplate, normalizeLanguage } = require('../src/utils/notificationTemplates');
const { buildAcceptanceFields, requireAcceptance, LEGAL_VERSION } = require('../src/config/legalAcceptance');
const { authValidation } = require('../src/validations');

const placeholders = (text) => (text.match(/\{(\w+)\}/g) || []).sort().join(',');

// Every template exists in both languages with the same placeholders.
for (const [key, entry] of Object.entries(TEMPLATES)) {
  assert.ok(entry.en && entry.hi, `${key} needs en and hi`);
  assert.strictEqual(placeholders(entry.en.body), placeholders(entry.hi.body), `${key} body placeholders`);
  assert.strictEqual(placeholders(entry.en.title), placeholders(entry.hi.title), `${key} title placeholders`);
}

// Rendering fills params, blanks missing ones and falls back to English.
assert.strictEqual(renderTemplate('priceChanged', 'en', { productName: 'Pump', retailPrice: 550 }).body, 'Pump is now ₹550.');
assert.ok(renderTemplate('priceChanged', 'hi', { productName: 'Pump', retailPrice: 550 }).body.includes('₹550'));
assert.strictEqual(renderTemplate('orderShipped', 'fr').title, 'Order Shipped!');
assert.strictEqual(renderTemplate('paymentRejectedWithReason', 'en', { orderNumber: 'A1' }).body.endsWith(': '), true);
assert.strictEqual(normalizeLanguage(undefined), 'en');
assert.throws(() => renderTemplate('nope', 'en'));

// Terms acceptance is stamped only when both boxes are ticked.
const now = new Date('2026-10-12T00:00:00Z');
assert.deepStrictEqual(buildAcceptanceFields({}, now), {});
assert.deepStrictEqual(buildAcceptanceFields({ termsAccepted: true }, now), {});
const stamped = buildAcceptanceFields({ termsAccepted: true, privacyPolicyAccepted: true }, now);
assert.strictEqual(stamped.termsAcceptedVersion, LEGAL_VERSION);
assert.strictEqual(stamped.privacyAcceptedAt, now);
assert.strictEqual(buildAcceptanceFields({ termsAccepted: true, privacyPolicyAccepted: true, termsVersion: '2020-01-01' }, now).termsAcceptedVersion, '2020-01-01');
assert.strictEqual(requireAcceptance(), process.env.REQUIRE_TERMS_ACCEPTANCE === 'true');

// Signup accepts the new fields and an old client without them.
const base = { name: 'Asha', phone: '9812345670', password: 'secret1' };
assert.ifError(authValidation.registerPhone.validate(base).error);
assert.ifError(authValidation.registerPhone.validate({ ...base, termsAccepted: true, privacyPolicyAccepted: true, termsVersion: '2026-10-12', privacyPolicyVersion: '2026-10-12' }).error);
assert.ok(authValidation.updatePreferences.validate({ language: 'fr' }).error);
assert.ifError(authValidation.updatePreferences.validate({ language: 'hi' }).error);

// CORS: exact origins only, no wildcard *.vercel.app.
const app = require('../src/app');
const server = http.createServer(app).listen(0, async () => {
  const { port } = server.address();
  const probe = (origin) => new Promise((resolve, reject) => {
    http.get({ port, path: '/health', headers: { Origin: origin } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, allow: res.headers['access-control-allow-origin'] });
    }).on('error', reject);
  });
  try {
    assert.strictEqual((await probe('https://veepee-admin.vercel.app')).allow, 'https://veepee-admin.vercel.app');
    assert.strictEqual((await probe('https://www.veepeeimpex.com')).allow, 'https://www.veepeeimpex.com');
    assert.strictEqual((await probe('https://evil-app.vercel.app')).status, 500);
    assert.strictEqual((await probe('https://evil.example.com')).status, 500);
    console.log('phase1 tests passed');
    server.close(() => process.exit(0));
  } catch (error) {
    console.error(error);
    server.close(() => process.exit(1));
  }
});
