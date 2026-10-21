// End-to-end QA pass over the API, run against the local development API
// and database only (scripts/dev/startDevApi.js + seedDev.js).
//   node scripts/dev/qaApi.js
// Prints PASS / FAIL / BUG lines and writes /tmp/oxon-qa-api.json.
//   PASS  the feature works as intended
//   FAIL  the feature is broken
//   BUG   a known-risk behaviour that was reproduced
//   INFO  observation, or not testable locally
const { uri } = require('./devEnv');
const fs = require('fs');
const mongoose = require('mongoose');

const BASE = process.env.QA_API || 'http://localhost:5055/api/v1';
const results = [];
let section = '';

const record = (status, name, detail = '') => {
  results.push({ section, status, name, detail });
  const pad = { PASS: 'PASS', FAIL: 'FAIL', BUG: 'BUG ', INFO: 'INFO' }[status];
  console.log(`${pad}  [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const check = (ok, name, detail) => record(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail);
const bugIf = (reproduced, name, detail) => record(reproduced ? 'BUG' : 'PASS', name, reproduced ? detail : 'not reproduced');

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}
const code = (res) => res.json?.error?.code || res.json?.code;
const phone = () => {
  for (;;) {
    const p = String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    if (!/^(\d)\1+$/.test(p) && new Set(p).size > 4 && !'0123456789'.includes(p) && !'9876543210'.includes(p)) return p;
  }
};
const address = { fullName: 'QA Tester', phone: '9812345670', addressLine1: '1 QA Street', city: 'Raipur', state: 'Chhattisgarh', pincode: '492001' };

async function main() {
  await mongoose.connect(uri);
  const db = require('../../src/models');

  // ---------------------------------------------------------------- setup
  section = 'setup';
  const adminLogin = await call('POST', '/auth/login', { body: { email: 'admin@veepee.dev', password: 'Admin@12345' } });
  check(adminLogin.status === 200, 'admin can log in', JSON.stringify(adminLogin.json).slice(0, 200));
  const admin = adminLogin.json.data?.accessToken;
  const staffLogin = await call('POST', '/auth/staff-login', { body: { email: 'staff@veepee.dev', password: 'Staff@12345' } });
  check(staffLogin.status === 200, 'staff can log in from the staff login', JSON.stringify(staffLogin.json).slice(0, 200));
  const staff = staffLogin.json.data?.accessToken;
  const buyerLogin = await call('POST', '/auth/login-phone', { body: { phone: '9812345670', password: 'Buyer@123', expectedRole: 'buyer' } });
  check(buyerLogin.status === 200, 'seeded buyer can log in with phone');
  const buyer = buyerLogin.json.data?.accessToken;
  const wsLogin = await call('POST', '/auth/login-phone', { body: { phone: '9812345671', password: 'Whole@123', expectedRole: 'wholesaler' } });
  check(wsLogin.status === 200, 'seeded wholesaler can log in with phone');
  const wholesaler = wsLogin.json.data?.accessToken;
  const bySku = async (sku) => db.Product.findOne({ sku }).lean();
  const pump = await bySku('DEV-PUMP-1');
  const pump2 = await bySku('DEV-PUMP-2');
  const sprayer = await bySku('DEV-SPR-16');
  const knapsack = await bySku('DEV-SPR-KN');
  const shears = await bySku('DEV-TOOL-PS');
  const hoe = await bySku('DEV-TOOL-HOE');
  const draft = await bySku('DEV-TILL-DR');
  const archived = await bySku('DEV-OLD-HP');
  const drip = await bySku('DEV-DRIP-CS');
  const weeder = await bySku('DEV-WEED-CS');
  const nozzle = await bySku('DEV-NOZ-BR');

  // ---------------------------------------------------------------- public
  section = 'public';
  let r = await call('GET', '/health');
  check(r.status === 200, 'health endpoint responds');
  bugIf(JSON.stringify(r.json).includes('127.0.0.1') || JSON.stringify(r.json).includes('oxon_dev') || /pid|memory/i.test(JSON.stringify(r.json)),
    'public /health discloses infrastructure details', 'database host/name, process and memory details are public');
  r = await call('GET', '/settings/banners');
  check(r.status === 200 && r.json.data?.heroBanners?.length === 2, 'banners endpoint returns active hero banners', JSON.stringify(r.json).slice(0, 200));
  r = await call('GET', '/settings/payment-options');
  check(r.status === 200 && r.json.data?.upiId === 'veepeeimpex.dev@upi', 'payment options endpoint', JSON.stringify(r.json).slice(0, 200));
  r = await call('GET', '/settings/mobile-app');
  check(r.status === 200 && r.json.data?.android?.enabled === false, 'mobile app update rule');
  r = await call('GET', '/settings/website-content');
  check(r.status === 200, 'website content endpoint');
  r = await call('GET', '/reviews');
  check(r.status === 200 && r.json.data.length === 2, 'public reviews list only active reviews', `got ${r.json.data?.length}`);
  // Expired / future offers should not be advertised.
  await db.Offer.create({ title: 'QA expired', discountType: 'percentage', discountValue: 50, code: `QAEXP${Date.now() % 100000}`, targetGroup: 'all', minPurchaseAmount: 0, isActive: true, startDate: new Date(Date.now() - 10 * 86400000), endDate: new Date(Date.now() - 86400000) });
  r = await call('GET', '/offers');
  bugIf(r.json.data?.some((o) => o.title === 'QA expired'), 'public offers list includes expired offers', 'an offer whose end date has passed is still listed (with its code)');

  // ---------------------------------------------------------------- auth
  section = 'auth';
  const newPhone = phone();
  r = await call('POST', '/auth/register-phone', { body: { name: 'QA New Buyer', phone: newPhone, password: 'abc123', termsAccepted: true, privacyPolicyAccepted: true, termsVersion: '2026-10-12', privacyPolicyVersion: '2026-10-12' } });
  check(r.status === 201, 'buyer phone signup with terms', JSON.stringify(r.json).slice(0, 200));
  const qaBuyer = r.json.data?.accessToken;
  const qaBuyerRefresh = r.json.data?.refreshToken;
  bugIf(r.status === 201, 'phone signup accepts a 6-character password', 'password minimum is 6 for phone signup but 8 for staff/password change');
  r = await call('POST', '/auth/register-phone', { body: { name: 'Dup', phone: newPhone, password: 'abcdef12' } });
  check(r.status === 409, 'duplicate phone is rejected', `status ${r.status}`);
  r = await call('POST', '/auth/register-phone', { body: { name: 'Bad', phone: '1234567890', password: 'abcdef12' } });
  check(r.status === 400, 'non-Indian phone rejected at signup');
  r = await call('POST', '/auth/register-phone', { body: { name: 'Seq', phone: '9876543210', password: 'abcdef12' } });
  check(r.status === 400, 'sequential phone rejected at signup');
  const wsPhone = phone();
  r = await call('POST', '/auth/register-phone/wholesaler', { body: { name: 'QA Instant Wholesaler', phone: wsPhone, password: 'abcdef12' } });
  bugIf(r.status === 201 && r.json.data?.user?.role === 'wholesaler', 'wholesaler signup grants wholesale prices immediately',
    'a brand-new account gets role "wholesaler" (and wholesale prices) with no admin approval; businessName is optional');
  r = await call('POST', '/auth/login-phone', { body: { phone: newPhone, password: 'wrong-pass' } });
  check(r.status === 401, 'wrong password rejected');
  r = await call('POST', '/auth/login-phone', { body: { phone: '9812345671', password: 'Whole@123', expectedRole: 'buyer' } });
  check(r.status === 401 && code(r) === 'AUTH_ROLE_MISMATCH', 'role mismatch at login is explained');
  r = await call('POST', '/auth/login', { body: { email: 'staff@veepee.dev', password: 'Staff@12345' } });
  check(r.status === 403 && code(r) === 'STAFF_LOGIN_REQUIRED', 'staff are turned away from the admin login');
  r = await call('POST', '/auth/google', { body: { idToken: 'anything-at-all', phone: phone() } });
  check(r.status === 404, 'Google sign-in route is removed', `POST /auth/google → ${r.status}`);
  r = await call('POST', '/auth/send-otp', { body: { phone: newPhone } });
  bugIf(r.status === 200, 'send-otp is a stub', 'reports "OTP sent" but nothing is sent');
  r = await call('POST', '/auth/verify-phone', { body: { phone: newPhone, otp: '123456' } });
  const verified = await db.User.findOne({ phone: newPhone }).lean();
  bugIf(r.status === 200 && !verified.phoneVerified, 'verify-phone accepts hard-coded 123456 but never saves phoneVerified',
    'OTP 123456 always passes and the user is never marked verified');
  r = await call('GET', '/auth/me', { token: qaBuyer });
  check(r.status === 200 && r.json.data?.phone === newPhone, '/auth/me returns the signed-in user');
  r = await call('PUT', '/auth/profile', { token: qaBuyer, body: { name: 'QA Renamed', address: 'New address' } });
  check(r.status === 200 && r.json.data?.name === 'QA Renamed', 'profile name/address update');
  r = await call('PUT', '/auth/profile', { token: qaBuyer, body: { phone: '1111111111' } });
  bugIf(r.status === 200 && r.json.data?.phone === '1111111111', 'profile phone change is not validated or re-verified',
    'phone can be changed to 1111111111 (fails the signup rules) with no OTP');
  r = await call('PUT', '/auth/preferences', { token: qaBuyer, body: { language: 'hi' } });
  check(r.status === 200, 'language preference saved');
  r = await call('POST', '/auth/refresh-token', { body: { refreshToken: qaBuyerRefresh } });
  check(r.status === 200 && r.json.data?.refreshToken !== qaBuyerRefresh, 'refresh token rotates');
  const rotated = r.json.data?.refreshToken;
  r = await call('POST', '/auth/refresh-token', { body: { refreshToken: qaBuyerRefresh } });
  check(r.status === 401, 'an old refresh token cannot be reused');
  r = await call('GET', '/auth/me', { token: rotated });
  check(r.status === 401, 'a refresh token is not accepted as an access token');
  r = await call('POST', '/auth/change-password', { token: r.json?.data ? qaBuyer : qaBuyer, body: { currentPassword: 'abc123', newPassword: 'newpass123' } });
  check(r.status === 200, 'change password', JSON.stringify(r.json).slice(0, 150));
  const qaBuyer2 = r.json.data?.accessToken || qaBuyer;
  r = await call('POST', '/auth/logout', { token: qaBuyer2, body: { refreshToken: r.json.data?.refreshToken } });
  check(r.status === 200, 'logout');

  // ---------------------------------------------------------------- catalogue
  section = 'catalogue';
  r = await call('GET', '/products?limit=50');
  const listed = r.json.data || [];
  check(r.status === 200, 'product list');
  check(!listed.some((p) => [draft, archived].some((x) => String(x._id) === String(p.id))), 'draft and archived products are not listed');
  check(!listed.some((p) => [drip, weeder].some((x) => String(x._id) === String(p.id))), 'coming-soon products are not in the normal list');
  r = await call('GET', '/products?comingSoon=true');
  check(r.json.data?.length === 2, 'coming-soon list', `got ${r.json.data?.length}`);
  check(r.json.data?.find((p) => p.name.includes('Weeder'))?.price === null, 'hidden price is null for the weeder');
  r = await call('GET', '/products?isHot=true&limit=50');
  check(r.json.data?.every((p) => p.isHot), 'hot filter');
  r = await call('GET', '/products?featured=true&limit=50');
  check(r.json.data?.every((p) => p.isFeatured), 'featured filter');
  r = await call('GET', '/products?inStock=true&limit=50');
  check(r.json.data?.every((p) => p.stock > 0), 'in-stock filter');
  r = await call('GET', '/products?sort=price&limit=50');
  const sortedPrices = (r.json.data || []).map((p) => p.price);
  check(sortedPrices.every((p, i) => i === 0 || p >= sortedPrices[i - 1]), 'sort by price ascending', sortedPrices.join(','));
  bugIf(!sortedPrices.every((p, i) => i === 0 || p >= sortedPrices[i - 1]), 'sorting by price ignores brand/category discounts',
    'the list is sorted by the stored retail price, but shoppers see the discounted price, so the order looks wrong');
  r = await call('GET', '/products/search?q=pump');
  check(r.status === 200 && r.json.data?.length >= 2, 'search "pump"', `got ${r.json.data?.length}`);
  r = await call('GET', '/products/search?q=' + encodeURIComponent('(a+)+$'));
  check(r.status === 200, 'search with regex characters does not crash', `status ${r.status}`);
  r = await call('GET', `/products/${pump.slug}`);
  check(r.status === 200 && r.json.data?.price === 7650 && r.json.data?.discountPercent === 10, 'category discount applied on detail (8500 − 10%)', `price ${r.json.data?.price}`);
  r = await call('GET', `/products/${sprayer.slug}`);
  bugIf(r.json.data?.price > sprayer.retailPrice, 'a brand "discount" can raise the price above the normal retail price',
    `AgriPlus 5% off MRP gives ₹${r.json.data?.price}, more than the stored retail price ₹${sprayer.retailPrice}`);
  r = await call('GET', `/products/${draft._id}`);
  bugIf(r.status === 200, 'draft products are public by id', 'GET /products/<draft id> returns the unpublished product with prices');
  r = await call('GET', `/products/${archived._id}`);
  bugIf(r.status === 200, 'archived products are public by id', 'GET /products/<archived id> returns the product');
  r = await call('GET', `/products/${pump._id}/related`);
  check(r.status === 200, 'related products');
  r = await call('GET', '/products/categories');
  check(r.status === 200 && r.json.data?.length === 5, 'product categories', `got ${r.json.data?.length}`);
  r = await call('GET', '/products/featured');
  check(r.status === 200 && r.json.data?.length >= 2, 'featured products');
  r = await call('POST', `/products/${pump._id}/view`, { body: { source: 'home' } });
  check(r.status === 200, 'view tracking');
  r = await call('POST', `/products/${pump._id}/event`, { body: { event: 'share' } });
  bugIf(r.status === 400, 'share events are rejected', 'POST /products/:id/event {event:"share"} → 400 because ANALYTICS_EVENTS.SHARE is undefined');
  r = await call('POST', `/products/${pump._id}/event`, { body: { event: 'cart_add', source: 'home' } });
  check(r.status === 200, 'cart_add event tracking', `status ${r.status}`);
  r = await call('GET', '/categories?limit=50');
  check(r.status === 200 && r.json.data?.length === 5, 'category list');
  r = await call('GET', '/categories/slug/irrigation');
  check(r.status === 200 && r.json.data?.subcategories?.length === 1, 'category by slug with subcategories');
  r = await call('GET', '/companies?limit=50');
  check(r.status === 200 && r.json.data?.length === 4, 'brand list');
  check(r.json.data?.map((c) => c.name).join(',') === 'Kirlo,AgriPlus,EcoTech,V-Flow', 'brands are in admin display order', r.json.data?.map((c) => c.name).join(','));
  r = await call('GET', '/companies?search=' + encodeURIComponent('C++'));
  bugIf(r.status === 500, 'brand search with special characters crashes (500)', 'search "C++" is used as a raw regular expression');
  const vflow = await db.Company.findOne({ name: 'V-Flow' }).lean();
  await db.Product.updateOne({ _id: draft._id }, { $set: { company: vflow._id } });
  r = await call('GET', `/companies/${vflow._id}/products`);
  bugIf((r.json.data?.products || []).some((p) => p.status !== 'active'), 'public brand products include draft/archived/coming-soon', 'GET /companies/:id/products returns non-active products with prices');

  // ---------------------------------------------------------------- cart
  section = 'cart';
  await call('DELETE', '/cart', { token: buyer });
  r = await call('POST', '/cart/items', { token: buyer, body: { productId: String(pump._id), quantity: 2 } });
  check(r.status === 200 && r.json.data?.items?.[0]?.currentPrice === 7650, 'add to cart uses the discounted price', JSON.stringify(r.json).slice(0, 200));
  r = await call('POST', '/cart/items', { token: buyer, body: { productId: String(knapsack._id), quantity: 1 } });
  check(r.status === 400 && code(r) === 'INSUFFICIENT_STOCK', 'out-of-stock product cannot be added');
  r = await call('POST', '/cart/items', { token: buyer, body: { productId: String(drip._id), quantity: 1 } });
  check(code(r) === 'PRODUCT_COMING_SOON', 'coming-soon product cannot be added');
  r = await call('POST', '/cart/items', { token: buyer, body: { productId: String(draft._id), quantity: 1 } });
  check(code(r) === 'PRODUCT_UNAVAILABLE', 'draft product cannot be added');
  r = await call('POST', '/cart/items', { token: buyer, body: { productId: String(hoe._id), quantity: 1 } });
  check(code(r) === 'INVALID_QUANTITY', 'customer minimum quantity enforced (hoe min 2)');
  r = await call('POST', '/cart/items', { token: buyer, body: { productId: String(hoe._id), quantity: 2 } });
  check(r.status === 200, 'add at the minimum quantity');
  r = await call('PUT', `/cart/items/${pump._id}`, { token: buyer, body: { quantity: 3 } });
  check(r.status === 200 && r.json.data.items.find((i) => String(i.productId) === String(pump._id)).quantity === 3, 'update quantity');
  r = await call('PUT', `/cart/items/${sprayer._id}`, { token: buyer, body: { quantity: 1 } });
  bugIf(r.status === 200, 'updating a product that is not in the cart returns 200', '"Cart updated" for an item that is not in the cart');
  r = await call('POST', '/cart/validate', { token: buyer });
  check(r.status === 200 && r.json.data?.valid === true, 'cart validation passes for a valid cart', JSON.stringify(r.json.data).slice(0, 200));
  r = await call('DELETE', `/cart/items/${hoe._id}`, { token: buyer });
  check(r.status === 200 && r.json.data.items.length === 1, 'remove item');
  r = await call('POST', '/cart/items', { token: wholesaler, body: { productId: String(shears._id), quantity: 12 } });
  check(code(r) === 'INVALID_QUANTITY', 'wholesaler pack minimum (2 packs of 12) enforced');
  r = await call('POST', '/cart/items', { token: wholesaler, body: { productId: String(shears._id), quantity: 24 } });
  check(r.status === 200 && r.json.data.items[0].product.quantityStep === 12, 'wholesaler adds two packs');
  await call('DELETE', '/cart', { token: wholesaler });

  // ---------------------------------------------------------------- orders & coupons
  section = 'orders';
  r = await call('POST', '/orders/preview-coupon', { token: buyer, body: { couponCode: 'WELCOME10' } });
  check(r.status === 200 && r.json.data?.discount > 0, 'coupon preview on the cart', JSON.stringify(r.json).slice(0, 200));
  r = await call('POST', '/orders/preview-coupon', { token: buyer, body: { couponCode: 'WELCOME10', subtotal: 100000 } });
  bugIf(r.status === 200 && r.json.data?.discount === 1000, 'coupon preview trusts a subtotal sent by the app', 'any subtotal can be previewed (only a preview — the order recalculates)');
  r = await call('POST', '/orders/preview-coupon', { token: buyer, body: { couponCode: 'DEALER500' } });
  check(r.status === 400, 'wholesaler coupon rejected for a buyer', `status ${r.status}`);
  r = await call('POST', '/orders/preview-coupon', { token: buyer, body: { couponCode: 'NOPE' } });
  check(r.status === 400 || r.status === 404, 'unknown coupon rejected');
  const offerBefore = await db.Offer.findOne({ code: 'WELCOME10' }).lean();
  r = await call('POST', '/orders', { token: buyer, body: { shippingAddress: address, couponCode: 'WELCOME10' } });
  check(r.status === 201, 'place a cart order with a coupon', JSON.stringify(r.json).slice(0, 200));
  const cartOrderId = r.json.data?.orderId;
  const cartOrder = await db.Order.findById(cartOrderId).lean();
  check(cartOrder && cartOrder.subtotal === 3 * 7650 && cartOrder.discount === 1000 && cartOrder.total === 3 * 7650 + 50 - 1000, 'order totals: subtotal, 10% coupon capped at ₹1000, ₹50 delivery', JSON.stringify(cartOrder && { s: cartOrder.subtotal, d: cartOrder.discount, t: cartOrder.total }));
  r = await call('GET', '/cart', { token: buyer });
  check(r.json.data?.items?.length === 0, 'cart is emptied after ordering');
  const offerAfter = await db.Offer.findOne({ code: 'WELCOME10' }).lean();
  bugIf(offerAfter.usageCount === offerBefore.usageCount + 1, 'coupon usage counted on an unpaid order', 'usage increments when the order is created, before payment, and is never reversed on cancel');
  r = await call('GET', '/orders', { token: buyer });
  check(r.status === 200 && r.json.data?.some((o) => String(o.id || o._id) === String(cartOrderId)), 'my orders list');
  r = await call('GET', `/orders/${cartOrderId}`, { token: buyer });
  check(r.status === 200, 'order detail for the owner');
  r = await call('GET', `/orders/${cartOrderId}`, { token: wholesaler });
  check(r.status === 404, 'another user cannot see the order');
  // Buy Now edge cases.
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(pump2._id), quantity: 2 }, { productId: String(pump2._id), quantity: 2 }], shippingAddress: address } });
  bugIf(r.status === 201, 'Buy Now with the same product twice bypasses the stock check', `pump stock is ${pump2.stock}, order for 4 accepted`);
  if (r.status === 201) await db.Order.updateOne({ _id: r.json.data.orderId }, { $set: { status: 'cancelled' } });
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(new mongoose.Types.ObjectId()), quantity: 1 }, { productId: String(nozzle._id), quantity: 1 }], shippingAddress: address } });
  bugIf(r.status === 201, 'Buy Now silently drops unknown products', 'an order with one unknown product id is created with only the valid line');
  const nozzleOrderId = r.json.data?.orderId;
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(drip._id), quantity: 1 }], shippingAddress: address } });
  check(r.status === 400, 'coming-soon product cannot be bought directly');
  await db.Settings.updateOne({ _id: 'app_settings' }, { $set: { minOrderAmount: 100000 } });
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(nozzle._id), quantity: 1 }], shippingAddress: address } });
  bugIf(r.status === 201, 'minimum order amount setting is not enforced', 'minOrderAmount ₹1,00,000 set, a ₹199 order is accepted');
  await db.Settings.updateOne({ _id: 'app_settings' }, { $set: { minOrderAmount: 0 } });

  // ---------------------------------------------------------------- payments & admin order flow
  section = 'payments';
  r = await call('GET', `/payments/${cartOrderId}`, { token: buyer });
  check(r.status === 200, 'payment status for my order');
  r = await call('GET', '/payments/upi-details');
  check(r.status === 200, 'UPI details');
  r = await call('GET', '/admin/payments', { token: admin });
  check(r.status === 200, 'admin payment list');
  const payment = await db.Payment.findOne({ orderId: cartOrderId }).lean();
  const stockBefore = (await db.Product.findById(pump._id).lean()).stock;
  r = await call('PUT', `/admin/payments/${payment._id}/verify`, { token: admin, body: {} });
  bugIf(r.status === 200, 'a payment with no screenshot can be verified', 'admin can verify a payment the customer never uploaded');
  const afterVerify = await db.Order.findById(cartOrderId).lean();
  const stockAfter = (await db.Product.findById(pump._id).lean()).stock;
  check(afterVerify.status === 'processing' && stockAfter === stockBefore - 3, 'verifying moves the order to processing and deducts stock', `status ${afterVerify.status}, stock ${stockBefore}→${stockAfter}`);
  r = await call('PUT', `/admin/orders/${cartOrderId}/ship`, { token: staff, body: { trackingNumber: 'QA123', courierName: 'QA Courier' } });
  check(r.status === 200, 'staff can ship an order', JSON.stringify(r.json).slice(0, 150));
  r = await call('PUT', `/admin/orders/${cartOrderId}/status`, { token: staff, body: { status: 'delivered' } });
  check(r.status === 200, 'mark delivered');
  r = await call('PUT', `/admin/orders/${cartOrderId}/status`, { token: staff, body: { status: 'cancelled' } });
  check(r.status === 400, 'a delivered order cannot be cancelled', `status ${r.status}`);
  // Rejection then re-upload.
  const payNozzle = await db.Payment.findOne({ orderId: nozzleOrderId });
  await db.Payment.updateOne({ _id: payNozzle._id }, { $set: { screenshotUrl: 'https://example.com/shot.png', uploadedAt: new Date() } });
  await db.Order.updateOne({ _id: nozzleOrderId }, { $set: { status: 'payment_uploaded' } });
  r = await call('PUT', `/admin/payments/${payNozzle._id}/reject`, { token: admin, body: { reason: 'Blurry' } });
  check(r.status === 200, 'admin rejects a payment');
  const rejected = await db.Payment.findById(payNozzle._id).lean();
  bugIf(Boolean(rejected.screenshotUrl), 'after a rejection the customer cannot upload a new screenshot',
    'screenshotUrl stays set after rejection; the upload endpoint refuses because a screenshot "already exists"');
  // Verify with insufficient stock.
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(sprayer._id), quantity: 5 }], shippingAddress: address } });
  const lowOrderId = r.json.data?.orderId;
  await db.Product.updateOne({ _id: sprayer._id }, { $set: { stock: 2 } });
  const lowPayment = await db.Payment.findOne({ orderId: lowOrderId });
  r = await call('PUT', `/admin/payments/${lowPayment._id}/verify`, { token: admin, body: {} });
  const lowAfter = await db.Payment.findById(lowPayment._id).lean();
  const lowOrder = await db.Order.findById(lowOrderId).lean();
  bugIf(r.status !== 200 && lowAfter.status === 'verified', 'verifying a payment when stock ran out leaves it half-done',
    `API ${r.status}; payment saved as "${lowAfter.status}" but order stays "${lowOrder.status}" — cannot be retried`);
  await db.Product.updateOne({ _id: sprayer._id }, { $set: { stock: 50 } });
  // Ship straight from payment_verified skips stock deduction.
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(nozzle._id), quantity: 4 }], shippingAddress: address } });
  const shipOrderId = r.json.data?.orderId;
  await db.Order.updateOne({ _id: shipOrderId }, { $set: { status: 'payment_verified' } });
  const nozzleStock = (await db.Product.findById(nozzle._id).lean()).stock;
  r = await call('PUT', `/admin/orders/${shipOrderId}/ship`, { token: admin, body: { trackingNumber: 'QA2', courierName: 'QA' } });
  const nozzleStock2 = (await db.Product.findById(nozzle._id).lean()).stock;
  bugIf(r.status === 200 && nozzleStock2 === nozzleStock, 'shipping from "payment verified" skips stock deduction', `stock stayed ${nozzleStock} after shipping 4`);
  // Cancel from processing restores stock.
  r = await call('POST', '/orders', { token: buyer, body: { items: [{ productId: String(hoe._id), quantity: 2 }], shippingAddress: address } });
  const cancelOrderId = r.json.data?.orderId;
  const hoeStock = (await db.Product.findById(hoe._id).lean()).stock;
  await call('PUT', `/admin/payments/${(await db.Payment.findOne({ orderId: cancelOrderId }))._id}/verify`, { token: admin, body: {} });
  await call('PUT', `/admin/orders/${cancelOrderId}/status`, { token: admin, body: { status: 'cancelled', note: 'QA cancel' } });
  const hoeStock2 = (await db.Product.findById(hoe._id).lean()).stock;
  check(hoeStock2 === hoeStock, 'cancelling a processing order restores stock', `stock ${hoeStock} → ${hoeStock2}`);
  r = await call('GET', '/admin/orders?limit=50', { token: staff });
  check(r.status === 200 && r.json.data?.length >= 5, 'staff can list orders');
  r = await call('GET', '/admin/orders?search=' + encodeURIComponent('('), { token: admin });
  bugIf(r.status === 500, 'order search with "(" crashes (500)', 'search text is used as a raw regular expression');
  r = await call('GET', `/admin/orders/${cartOrderId}`, { token: admin });
  check(r.status === 200, 'admin order detail');
  section = 'razorpay';
  r = await call('POST', '/razorpay/verify', { token: buyer, body: { orderId: cartOrderId } });
  check(r.status === 404, 'Razorpay routes are removed', `POST /razorpay/verify → ${r.status}`);

  // ---------------------------------------------------------------- negotiations
  section = 'negotiations';
  r = await call('POST', '/negotiations', { token: buyer, body: { productId: String(nozzle._id), quantity: 1, pricePerUnit: 1 } });
  bugIf(r.status === 201, 'buyers (not only wholesalers) can open price negotiations', 'a buyer created a negotiation at ₹1');
  r = await call('POST', '/negotiations', { token: wholesaler, body: { productId: String(nozzle._id), quantity: 10, pricePerUnit: 0 } });
  bugIf(r.status === 201, 'a negotiation at ₹0 per unit is accepted', 'pricePerUnit 0 allowed');
  r = await call('POST', '/negotiations', { token: wholesaler, body: { productId: String(pump._id), quantity: 5, pricePerUnit: 6000, message: 'QA bulk' } });
  check(r.status === 201, 'wholesaler opens a negotiation');
  const negId = r.json.data?.id;
  r = await call('PUT', `/admin/negotiations/${negId}/counter`, { token: staff, body: { pricePerUnit: 6300, message: 'Best' } });
  check(r.status === 200, 'staff counters');
  r = await call('POST', `/negotiations/${negId}/counter`, { token: wholesaler, body: { pricePerUnit: 6200 } });
  check(r.status === 200, 'wholesaler counters back');
  r = await call('POST', `/negotiations/${negId}/accept`, { token: wholesaler });
  check(r.status === 400, 'wholesaler cannot accept their own offer');
  r = await call('PUT', `/admin/negotiations/${negId}/accept`, { token: admin, body: { message: 'ok' } });
  check(r.status === 200, 'admin accepts');
  // Expiry is never enforced.
  await db.Negotiation.updateOne({ _id: negId }, { $set: { expiresAt: new Date(Date.now() - 86400000) } });
  const [o1, o2] = await Promise.all([
    call('POST', '/orders/from-negotiation', { token: wholesaler, body: { negotiationId: negId, shippingAddress: address } }),
    call('POST', '/orders/from-negotiation', { token: wholesaler, body: { negotiationId: negId, shippingAddress: address } }),
  ]);
  bugIf([o1, o2].some((x) => x.status === 201), 'an expired negotiation can still be ordered', 'expiresAt in the past, order created');
  bugIf(o1.status === 201 && o2.status === 201, 'two orders for one negotiation when paid twice at once', 'parallel requests both created an order');
  record('INFO', 'parallel order-from-negotiation', `responses ${o1.status} and ${o2.status}`);
  // Requirement (group) flow.
  await call('DELETE', '/cart', { token: wholesaler });
  await call('POST', '/cart/items', { token: wholesaler, body: { productId: String(pump._id), quantity: 4 } });
  await call('POST', '/cart/items', { token: wholesaler, body: { productId: String(sprayer._id), quantity: 6 } });
  r = await call('POST', '/negotiations/from-cart', { token: wholesaler, body: { message: 'QA requirement' } });
  check(r.status === 201 && r.json.data?.requestGroup?.number, 'requirement from cart', JSON.stringify(r.json).slice(0, 200));
  const groupId = r.json.data?.requestGroup?.id;
  r = await call('GET', `/admin/negotiations/groups/${groupId}`, { token: staff });
  const lines = r.json.data?.items || [];
  r = await call('PUT', `/admin/negotiations/groups/${groupId}/counter`, { token: staff, body: { counters: lines.map((l) => ({ negotiationId: l.id, pricePerUnit: Math.round(l.currentPricePerUnit * 0.95) })) } });
  check(r.status === 200 && r.json.data?.status === 'countered', 'staff counters the requirement');
  r = await call('POST', `/negotiations/groups/${groupId}/accept`, { token: wholesaler });
  check(r.status === 200 && r.json.data?.canPay, 'wholesaler accepts; requirement payable');
  r = await call('POST', '/orders/from-group', { token: wholesaler, body: { groupId, shippingAddress: address } });
  check(r.status === 201, 'one order for the requirement');
  const groupOrderId = r.json.data?.orderId;
  r = await call('GET', '/admin/negotiations?limit=50', { token: admin });
  check(r.status === 200 && r.json.data?.some((n) => n.requestGroup?.id === groupId), 'admin list shows the requirement');

  // ---------------------------------------------------------------- admin catalogue
  section = 'admin-catalogue';
  r = await call('POST', '/admin/products', { token: admin, body: {
    name: 'QA Created Product', description: 'Created by QA', categoryIds: [String(pump.primaryCategoryId)], primaryCategoryId: String(pump.primaryCategoryId),
    mrp: 1000, retailPrice: 900, wholesalePrice: 800, sku: `QA-${Date.now()}`, stock: 10, status: 'active',
    images: [{ url: 'https://placehold.co/600x600/png?text=QA', publicId: 'qa/1', isPrimary: true, order: 0 }],
  } });
  check(r.status === 201, 'admin creates a product', JSON.stringify(r.json).slice(0, 200));
  const qaProductId = r.json.data?._id;
  r = await call('PUT', `/admin/products/${qaProductId}`, { token: admin, body: { name: 'QA Created Product v2', stock: 999 } });
  check(r.status === 200 && r.json.data?.name === 'QA Created Product v2', 'admin edits a product');
  const logs = await db.StockLog.countDocuments({ productId: qaProductId });
  bugIf(r.json.data?.stock === 999 && logs === 0, 'stock edited through the product form skips the stock log', 'stock changed to 999 with no StockLog entry');
  r = await call('PUT', `/admin/products/${qaProductId}/stock`, { token: admin, body: { adjustment: '+5', reason: 'QA' } });
  check(r.status === 200, 'stock adjustment', JSON.stringify(r.json).slice(0, 150));
  r = await call('GET', `/admin/products/${qaProductId}/stock-logs`, { token: admin });
  check(r.status === 200 && (r.json.data?.length || r.json.data?.logs?.length) >= 1, 'stock log list');
  r = await call('PUT', `/admin/products/${qaProductId}/price-change`, { token: admin, headers: { 'Idempotency-Key': `qa-${Date.now()}` }, body: { retailPrice: 850, priceChangeMode: 'immediate' } });
  check(r.status === 201 && r.json.data?.product?.retailPrice === 850, 'immediate price change', JSON.stringify(r.json).slice(0, 200));
  r = await call('PUT', `/admin/products/${qaProductId}/price-change`, { token: admin, headers: { 'Idempotency-Key': `qa-s-${Date.now()}` }, body: { retailPrice: 820, priceChangeMode: 'schedule_48h' } });
  check(r.status === 201 && r.json.data?.audit?.status === 'scheduled', 'scheduled price change');
  const scheduledAudit = r.json.data?.audit?._id;
  r = await call('PUT', `/admin/products/${qaProductId}/price-change`, { token: admin, headers: { 'Idempotency-Key': `qa-b-${Date.now()}` }, body: { wholesalePrice: 950, priceChangeMode: 'immediate' } });
  bugIf(r.status === 201, 'wholesale price can be set above the retail price', 'wholesale ₹950 accepted with retail ₹850');
  r = await call('POST', `/admin/price-changes/${scheduledAudit}/cancel`, { token: admin });
  record(r.status === 409 ? 'INFO' : (r.status === 200 ? 'PASS' : 'FAIL'), 'cancel a scheduled change', `status ${r.status} (409 means the immediate change above already replaced it)`);
  r = await call('GET', '/admin/price-changes', { token: admin });
  check(r.status === 200 && r.json.data?.length >= 2, 'price change list');
  r = await call('GET', '/admin/products/price-snapshot.xlsx', { token: admin });
  check(r.status === 200, 'price snapshot export');
  r = await call('DELETE', `/admin/products/${qaProductId}`, { token: admin });
  check(r.status === 200 && (await db.Product.findById(qaProductId).lean()).status === 'archived', 'delete archives the product');
  r = await call('POST', '/admin/products', { token: staff, body: { name: 'Staff product' } });
  check(r.status === 403, 'staff cannot create products');
  // Brands.
  r = await call('POST', '/companies', { token: admin, body: { name: `QA Brand ${Date.now() % 10000}`, description: 'QA' } });
  check(r.status === 201, 'create brand');
  const qaBrandId = r.json.data?._id;
  r = await call('PUT', `/companies/${qaBrandId}`, { token: staff, body: { description: 'edited by staff' } });
  check(r.status === 200, 'staff edits a brand');
  r = await call('POST', '/companies', { token: admin, body: { name: 'C++ Tools' } });
  bugIf(r.status === 500, 'creating a brand named "C++ Tools" crashes (500)', 'brand name is used as a raw regular expression');
  r = await call('PUT', `/admin/discounts/company/${qaBrandId}`, { token: admin, body: { customerDiscountPercent: 12 } });
  check(r.status === 200, 'set brand discount');
  r = await call('DELETE', `/companies/${qaBrandId}`, { token: admin });
  check(r.status === 200, 'delete an empty brand');
  const kirlo = await db.Company.findOne({ name: 'Kirlo' }).lean();
  r = await call('DELETE', `/companies/${kirlo._id}`, { token: admin });
  check(r.status === 400 || r.status === 409, 'cannot delete a brand with products', `status ${r.status}`);
  // Categories.
  r = await call('POST', '/categories', { token: admin, body: { name: `QA Cat ${Date.now() % 10000}`, order: 1 } });
  check(r.status === 201, 'create category', JSON.stringify(r.json).slice(0, 150));
  const qaCatId = r.json.data?._id;
  r = await call('PUT', `/categories/${qaCatId}`, { token: admin, body: { name: 'QA Cat Renamed', isActive: false } });
  check(r.status === 200, 'edit category');
  r = await call('GET', `/categories/${qaCatId}`);
  bugIf(r.status === 200 && r.json.data?.isActive === false, 'inactive categories are public', 'GET /categories/:id returns an inactive category');
  r = await call('DELETE', `/categories/${qaCatId}`, { token: admin });
  check(r.status === 200, 'delete empty category');

  // ---------------------------------------------------------------- admin people & settings
  section = 'admin-other';
  const pooja = await db.User.findOne({ phone: '9812345673' }).lean();
  r = await call('GET', `/admin/customers/${pooja._id}`, { token: admin });
  bugIf(r.status === 200 && JSON.stringify(r.json).includes('"$__"'), 'customer detail returns Mongoose internals', 'response contains $__/_doc instead of plain fields');
  const ravi = await db.User.findOne({ phone: '9812345672' }).lean();
  r = await call('PUT', `/admin/customers/${ravi._id}/upgrade`, { token: admin, body: { action: 'accept' } });
  bugIf(r.status === 200, 'any buyer can be upgraded without an application', 'Ravi never applied but was made a wholesaler');
  await db.User.updateOne({ _id: ravi._id }, { $set: { role: 'buyer' } });
  r = await call('PUT', `/admin/customers/${pooja._id}/upgrade`, { token: admin, body: { action: 'accept' } });
  check(r.status === 200 && (await db.User.findById(pooja._id).lean()).role === 'wholesaler', 'approve a pending wholesaler application');
  r = await call('POST', '/admin/customers/notifications', { token: admin, body: { userIds: [String(ravi._id)], title: 'QA hello', body: 'Test' } });
  record(r.status === 200 ? 'PASS' : 'INFO', 'custom notification to a customer', `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call('GET', '/admin/settings', { token: admin });
  bugIf('razorpayKeySecret' in (r.json.data || {}), 'settings API returns the Razorpay secret', 'GET /admin/settings includes razorpayKeySecret');
  r = await call('PUT', '/admin/settings', { token: admin, body: { businessName: 'QA Biz', razorpayKeyId: 'rzp_test_x' } });
  const s = await db.Settings.findById('app_settings').lean();
  check(r.status === 200 && s.businessName === 'QA Biz', 'save settings');
  check(!s.razorpayKeyId, 'Razorpay keys are not saved (the gateway was removed)');
  await db.Settings.updateOne({ _id: 'app_settings' }, { $set: { businessName: 'VeepeeImpex (Dev)' } });
  r = await call('POST', '/admin/staff', { token: admin, body: { name: 'QA Staff', email: `qa${Date.now()}@veepee.dev`, password: 'TempPass123' } });
  check(r.status === 201, 'create staff');
  const qaStaffId = r.json.data?._id;
  r = await call('POST', `/admin/staff/${qaStaffId}/reset-password`, { token: admin });
  check(r.status === 200 && r.json.data?.temporaryPassword, 'reset staff password');
  r = await call('PATCH', `/admin/staff/${qaStaffId}`, { token: admin, body: { isActive: false } });
  check(r.status === 200, 'deactivate staff');
  r = await call('GET', '/admin/staff?search=' + encodeURIComponent('('), { token: admin });
  bugIf(r.status === 500, 'staff search with "(" crashes (500)', 'raw regex');
  r = await call('POST', '/admin/offers', { token: admin, body: { title: 'QA Offer', discountType: 'fixed', discountValue: 50, code: `QA${Date.now() % 100000}`, targetGroup: 'all' } });
  check(r.status === 201, 'create offer', JSON.stringify(r.json).slice(0, 150));
  const qaOfferId = r.json.data?._id;
  r = await call('PATCH', `/admin/offers/${qaOfferId}/toggle`, { token: admin });
  check(r.status === 200, 'toggle offer');
  r = await call('PUT', `/admin/offers/${qaOfferId}`, { token: admin, body: { title: 'QA Offer edited' } });
  check(r.status === 200, 'edit offer', `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call('DELETE', `/admin/offers/${qaOfferId}`, { token: admin });
  check(r.status === 200, 'delete offer');
  r = await call('GET', '/admin/offers?search=' + encodeURIComponent('['), { token: admin });
  bugIf(r.status === 500, 'offer search with "[" crashes (500)', 'raw regex');
  r = await call('POST', '/admin/affiliate-codes', { token: admin, body: { code: `QAAFF${Date.now() % 1000}`, personName: 'QA Person', discountValue: 5 } });
  check(r.status === 201, 'create affiliate code');
  const qaAffId = r.json.data?._id;
  r = await call('PUT', `/admin/affiliate-codes/${qaAffId}`, { token: admin, body: { personName: 'QA Person 2' } });
  check(r.status === 200, 'edit affiliate code', `status ${r.status}`);
  r = await call('GET', `/admin/affiliate-codes/${qaAffId}/usage`, { token: admin });
  check(r.status === 200, 'affiliate usage');
  r = await call('DELETE', `/admin/affiliate-codes/${qaAffId}`, { token: admin });
  check(r.status === 200, 'delete affiliate code');
  r = await call('POST', '/admin/reviews', { token: admin, body: { name: 'QA', role: 'Tester', review: 'Great', rating: 5, isActive: true, injected: 'x' } });
  check(r.status === 201, 'create review', `status ${r.status}`);
  const qaReviewId = r.json.data?.review?._id || r.json.data?._id;
  r = await call('PUT', `/admin/reviews/${qaReviewId}`, { token: admin, body: { rating: 99 } });
  bugIf(r.status === 200, 'review rating 99 accepted on edit', `status ${r.status} — no validation on review edits`);
  r = await call('DELETE', `/admin/reviews/${qaReviewId}`, { token: admin });
  check([200, 204].includes(r.status), 'delete review', `status ${r.status}`);
  r = await call('POST', '/admin/reviews', { token: admin, body: { name: 'X', role: 'Y', review: 'Z', rating: 3, isActive: true, createdAt: '2001-01-01' } });
  bugIf(r.status === 201 && String(r.json.data?.review?.createdAt || '').startsWith('2001'), 'review create saves any field sent (no validation)', 'createdAt from the request body was stored as-is');
  r = await call('GET', '/admin/analytics/dashboard', { token: staff });
  check(r.status === 200, 'dashboard stats for staff');
  r = await call('GET', '/admin/analytics/demand', { token: admin });
  bugIf(r.status === 500, 'Demand Insights crashes when any product is low on stock', 'Product.primaryImage virtual reads images, which the low-stock query does not select → 500');
  for (const p of ['products', 'sales', 'potential-customers']) {
    r = await call('GET', `/admin/analytics/${p}`, { token: admin });
    check(r.status === 200, `analytics ${p}`, `status ${r.status}`);
  }
  r = await call('GET', '/admin/website-settings', { token: admin });
  check(r.status === 200, 'website settings');
  r = await call('GET', '/admin/notifications', { token: staff });
  check(r.status === 200 && r.json.unreadCount >= 1, 'team notification inbox has new-order items', `unread ${r.json.unreadCount}`);

  // ---------------------------------------------------------------- uploads (need Firebase Storage)
  section = 'uploads';
  r = await call('POST', '/upload/image', { token: admin, body: {} });
  record('INFO', 'image upload in dev', `status ${r.status} — Firebase Storage is not configured locally, so uploads cannot be tested here`);

  // ---------------------------------------------------------------- notifications (app)
  section = 'notifications';
  r = await call('GET', '/notifications/my?limit=100000', { token: buyer });
  check(r.status === 200, 'my notifications');
  r = await call('POST', '/notifications/mark-read', { token: buyer, body: {} });
  check(r.status === 200, 'mark all read');
  r = await call('POST', '/notifications/register-token', { token: buyer, body: { fcmToken: 'qa-token', platform: 'android' } });
  check(r.status === 200, 'register push token');
  r = await call('POST', '/notifications/register-token', { token: buyer, body: { fcmToken: 'qa-token-2', platform: 'windows' } });
  bugIf(r.status >= 500, 'an unknown platform crashes token registration', `status ${r.status}`);

  // ---------------------------------------------------------------- account deletion
  section = 'account-deletion';
  const delPhone = phone();
  r = await call('POST', '/auth/register-phone', { body: { name: 'QA Deleter', phone: delPhone, password: 'abcdef12' } });
  const delToken = r.json.data?.accessToken;
  r = await call('POST', '/auth/account-deletion-request', { token: delToken, body: {} });
  check([200, 201].includes(r.status), 'app deletion request');
  r = await call('POST', '/auth/account-deletion-request/cancel', { token: delToken });
  check(r.status === 200, 'cancel deletion request');
  r = await call('POST', '/account-deletion-request', { body: { name: 'QA Deleter', phone: delPhone, reason: 'QA' } });
  check(r.status === 202, 'website deletion request', `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await call('GET', '/admin/account-deletion-requests', { token: admin });
  check(r.status === 200 && r.json.data?.length >= 1, 'admin deletion request list');

  // ---------------------------------------------------------------- cron
  section = 'cron';
  r = await call('GET', '/internal/cron/daily');
  check(r.status === 401, 'cron requires the secret');
  r = await call('GET', '/internal/cron/daily', { headers: { Authorization: 'Bearer dev-cron-secret' } });
  check(r.status === 200, 'daily job runs', JSON.stringify(r.json).slice(0, 200));

  // ---------------------------------------------------------------- summary
  const totals = results.reduce((acc, x) => ({ ...acc, [x.status]: (acc[x.status] || 0) + 1 }), {});
  console.log('\nTotals:', totals);
  fs.writeFileSync('/tmp/oxon-qa-api.json', JSON.stringify({ totals, results }, null, 2));
  void groupOrderId;
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('QA script crashed:', error);
  fs.writeFileSync('/tmp/oxon-qa-api.json', JSON.stringify({ crashed: String(error), results }, null, 2));
  await mongoose.disconnect();
  process.exit(1);
});
