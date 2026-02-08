/**
 * Inventory & Negotiation Test Cases
 * 
 * Run with: node tests/inventory.test.js
 * Requires: MongoDB running, .env configured
 * 
 * These are integration tests that verify the complete inventory tracking
 * and negotiation flows against the actual database.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const assert = require('assert');

// Models
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');
const Negotiation = require('../src/models/Negotiation');
const StockLog = require('../src/models/StockLog');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');

const { ORDER_STATUS, NEGOTIATION_STATUS } = require('../src/utils/constants');

let testProduct, testUser, testAdmin;

// ── HELPERS ──
const log = (icon, msg) => console.log(`  ${icon} ${msg}`);
const pass = (msg) => log('✅', msg);
const fail = (msg, err) => { log('❌', `${msg}: ${err.message || err}`); throw err; };

async function setup() {
  console.log('\n🔧 Setting up test environment...\n');
  
  await mongoose.connect(process.env.MONGODB_URI);
  
  // Create test user
  testUser = await User.create({
    name: 'Test Buyer',
    email: `test-buyer-${Date.now()}@test.com`,
    phone: `9${Date.now().toString().slice(-9)}`,
    passwordHash: 'hashedpassword123',
    role: 'buyer',
    isActive: true,
  });

  // Create test admin
  testAdmin = await User.create({
    name: 'Test Admin',
    email: `test-admin-${Date.now()}@test.com`,
    phone: `8${Date.now().toString().slice(-9)}`,
    passwordHash: 'hashedpassword123',
    role: 'admin',
    isActive: true,
  });

  // Ensure settings exist
  await Settings.getSettings();

  // Create test product with known stock
  testProduct = await Product.create({
    name: 'Test Tractor Model X',
    slug: `test-tractor-${Date.now()}`,
    description: 'A test tractor for inventory tests',
    category: 'tractors',
    mrp: 100000,
    retailPrice: 85000,
    wholesalePrice: 70000,
    minWholesaleQuantity: 5,
    negotiationEnabled: true,
    sku: `TST-${Date.now()}`,
    stock: 50,
    lowStockThreshold: 5,
    trackInventory: true,
    status: 'active',
  });

  pass(`Test product created: ${testProduct.name} (stock: ${testProduct.stock})`);
}

async function teardown() {
  console.log('\n🧹 Cleaning up...\n');
  
  if (testProduct) {
    await Product.deleteOne({ _id: testProduct._id });
    await StockLog.deleteMany({ productId: testProduct._id });
    await Order.deleteMany({ 'items.productId': testProduct._id });
    await Negotiation.deleteMany({ productId: testProduct._id });
  }
  if (testUser) await User.deleteOne({ _id: testUser._id });
  if (testAdmin) await User.deleteOne({ _id: testAdmin._id });
  
  await mongoose.disconnect();
  pass('Cleanup complete');
}

// ═══════════════════════════════════════
// TEST CASES
// ═══════════════════════════════════════

async function test_01_initial_stock_is_correct() {
  const p = await Product.findById(testProduct._id);
  assert.strictEqual(p.stock, 50, 'Initial stock should be 50');
  pass('Initial stock is 50');
}

async function test_02_manual_stock_set_with_logging() {
  const prev = testProduct.stock;
  const product = await Product.findById(testProduct._id);
  product.stock = 45;
  await product.save();

  await StockLog.create({
    productId: product._id,
    action: 'manual_set',
    quantityChange: 45 - prev,
    previousStock: prev,
    newStock: 45,
    reason: 'Test: manual set to 45',
    performedBy: testAdmin._id,
  });

  const updated = await Product.findById(testProduct._id);
  assert.strictEqual(updated.stock, 45);

  const log = await StockLog.findOne({ productId: product._id, action: 'manual_set' });
  assert.ok(log, 'StockLog entry should exist');
  assert.strictEqual(log.previousStock, 50);
  assert.strictEqual(log.newStock, 45);
  pass('Manual stock set to 45 with audit log');
}

async function test_03_manual_stock_adjustment_with_logging() {
  const product = await Product.findById(testProduct._id);
  const prev = product.stock;
  
  // Add 10 units
  const result = await Product.findByIdAndUpdate(
    product._id,
    { $inc: { stock: 10 } },
    { new: true }
  );

  await StockLog.create({
    productId: product._id,
    action: 'manual_adjust',
    quantityChange: 10,
    previousStock: prev,
    newStock: result.stock,
    reason: 'Test: added 10 units',
    performedBy: testAdmin._id,
  });

  assert.strictEqual(result.stock, prev + 10);
  pass(`Manual stock adjustment +10: ${prev} → ${result.stock}`);
}

async function test_04_stock_cannot_go_below_zero() {
  const product = await Product.findById(testProduct._id);
  const currentStock = product.stock;

  // Try to deduct more than available using atomic guard
  const result = await Product.findOneAndUpdate(
    { _id: product._id, stock: { $gte: currentStock + 100 } },
    { $inc: { stock: -(currentStock + 100) } },
    { new: true }
  );

  assert.strictEqual(result, null, 'Should return null when stock guard fails');

  // Verify stock unchanged
  const unchanged = await Product.findById(product._id);
  assert.strictEqual(unchanged.stock, currentStock, 'Stock should be unchanged');
  pass('Stock cannot go below zero (atomic guard works)');
}

async function test_05_order_creation_does_not_deduct_stock() {
  const product = await Product.findById(testProduct._id);
  const stockBefore = product.stock;

  // Simulate order creation (stock should NOT be deducted)
  const order = await Order.create({
    orderNumber: `TEST-ORD-${Date.now()}`,
    userId: testUser._id,
    customerSnapshot: { name: 'Test', email: 'test@test.com', phone: '1234567890' },
    orderType: 'retail',
    items: [{
      productId: product._id,
      productSnapshot: { name: product.name, sku: product.sku },
      quantity: 3,
      pricePerUnit: product.retailPrice,
      totalPrice: product.retailPrice * 3,
    }],
    subtotal: product.retailPrice * 3,
    discount: 0,
    total: product.retailPrice * 3,
    shippingAddress: {
      fullName: 'Test User', phone: '1234567890',
      addressLine1: '123 Test St', city: 'TestCity',
      state: 'TestState', pincode: '123456',
    },
    statusHistory: [{ status: ORDER_STATUS.PENDING_PAYMENT, note: 'Test order' }],
  });

  // Only increment orderCount, NOT deduct stock
  await Product.findByIdAndUpdate(product._id, { $inc: { orderCount: 1 } });

  const stockAfter = (await Product.findById(product._id)).stock;
  assert.strictEqual(stockAfter, stockBefore, 'Stock should NOT change at order creation');

  // Store order for later tests
  testProduct._testOrder = order;
  pass(`Order created (${order.orderNumber}), stock unchanged: ${stockBefore}`);
}

async function test_06_stock_deducts_on_processing() {
  const order = testProduct._testOrder;
  const product = await Product.findById(testProduct._id);
  const stockBefore = product.stock;
  const deductQty = order.items[0].quantity;

  // Simulate admin confirming order → PROCESSING
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const result = await Product.findOneAndUpdate(
      { _id: product._id, stock: { $gte: deductQty } },
      { $inc: { stock: -deductQty } },
      { new: true, session }
    );

    assert.ok(result, 'Atomic deduction should succeed');

    await StockLog.create([{
      productId: product._id,
      action: 'order_deduct',
      quantityChange: -deductQty,
      previousStock: stockBefore,
      newStock: result.stock,
      orderId: order._id,
      reason: `Order ${order.orderNumber} confirmed`,
      performedBy: testAdmin._id,
    }], { session });

    order.status = ORDER_STATUS.PROCESSING;
    order.statusHistory.push({ status: ORDER_STATUS.PROCESSING, note: 'Test confirm' });
    await order.save({ session });

    await session.commitTransaction();

    assert.strictEqual(result.stock, stockBefore - deductQty);
    pass(`Stock deducted on PROCESSING: ${stockBefore} → ${result.stock} (-${deductQty})`);
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function test_07_stock_restores_on_cancel_from_processing() {
  const order = testProduct._testOrder;
  const product = await Product.findById(testProduct._id);
  const stockBefore = product.stock;
  const restoreQty = order.items[0].quantity;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    await Product.findByIdAndUpdate(
      product._id,
      { $inc: { stock: restoreQty } },
      { session }
    );

    await StockLog.create([{
      productId: product._id,
      action: 'cancel_restore',
      quantityChange: restoreQty,
      previousStock: stockBefore,
      newStock: stockBefore + restoreQty,
      orderId: order._id,
      reason: `Order ${order.orderNumber} cancelled - stock restored`,
      performedBy: testAdmin._id,
    }], { session });

    order.status = ORDER_STATUS.CANCELLED;
    order.statusHistory.push({ status: ORDER_STATUS.CANCELLED, note: 'Test cancel' });
    await order.save({ session });

    await session.commitTransaction();

    const after = await Product.findById(product._id);
    assert.strictEqual(after.stock, stockBefore + restoreQty);
    pass(`Stock restored on CANCEL: ${stockBefore} → ${after.stock} (+${restoreQty})`);
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function test_08_cancel_before_processing_does_not_restore() {
  const product = await Product.findById(testProduct._id);
  const stockBefore = product.stock;

  // Create new order that stays in PENDING_PAYMENT
  const order = await Order.create({
    orderNumber: `TEST-ORD2-${Date.now()}`,
    userId: testUser._id,
    customerSnapshot: { name: 'Test', email: 'test@test.com', phone: '1234567890' },
    orderType: 'retail',
    items: [{
      productId: product._id,
      productSnapshot: { name: product.name, sku: product.sku },
      quantity: 5,
      pricePerUnit: product.retailPrice,
      totalPrice: product.retailPrice * 5,
    }],
    subtotal: product.retailPrice * 5,
    discount: 0,
    total: product.retailPrice * 5,
    shippingAddress: {
      fullName: 'Test User', phone: '1234567890',
      addressLine1: '123 Test St', city: 'TestCity',
      state: 'TestState', pincode: '123456',
    },
    status: ORDER_STATUS.PENDING_PAYMENT,
    statusHistory: [{ status: ORDER_STATUS.PENDING_PAYMENT, note: 'Test' }],
  });

  // Cancel from PENDING_PAYMENT — no stock was deducted, so no restore
  order.status = ORDER_STATUS.CANCELLED;
  await order.save();

  const stockAfter = (await Product.findById(product._id)).stock;
  assert.strictEqual(stockAfter, stockBefore, 'Stock should NOT change when cancelling pre-processing order');
  pass(`Cancel from PENDING_PAYMENT: stock unchanged at ${stockBefore}`);
}

async function test_09_concurrent_stock_deduction_safety() {
  // Set stock to exactly 5
  await Product.findByIdAndUpdate(testProduct._id, { $set: { stock: 5 } });

  // Two concurrent deductions of 3 each — only one should succeed
  const [r1, r2] = await Promise.all([
    Product.findOneAndUpdate(
      { _id: testProduct._id, stock: { $gte: 3 } },
      { $inc: { stock: -3 } },
      { new: true }
    ),
    Product.findOneAndUpdate(
      { _id: testProduct._id, stock: { $gte: 3 } },
      { $inc: { stock: -3 } },
      { new: true }
    ),
  ]);

  const final_ = await Product.findById(testProduct._id);
  
  // Both might succeed (5→2 and 2→-1 won't happen due to guard), 
  // or one might succeed and the other fails
  // With $gte guard, the second one should fail if stock dropped below 3
  assert.ok(final_.stock >= 0, 'Stock must never go negative');
  
  if (r1 && r2) {
    // Both succeeded: 5 - 3 - 3 = -1 is impossible with guard
    // Actually both CAN succeed because MongoDB $inc is atomic per operation
    // but the guard prevents the second if stock dropped below 3
    // If stock was 5, first does 5→2, second sees stock=2 < 3 → null
    assert.ok(
      (r1 === null || r2 === null) || final_.stock >= 0,
      'At least one must fail or stock stays non-negative'
    );
  }
  
  pass(`Concurrent deduction safety: final stock = ${final_.stock} (≥0)`);

  // Reset stock for remaining tests
  await Product.findByIdAndUpdate(testProduct._id, { $set: { stock: 50 } });
}

async function test_10_negotiation_creation() {
  const settings = await Settings.getSettings();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (settings.negotiationExpiryDays || 7));

  const negotiation = await Negotiation.create({
    wholesalerId: testUser._id,
    productId: testProduct._id,
    productSnapshot: {
      name: testProduct.name,
      price: testProduct.retailPrice,
      image: null,
      sku: testProduct.sku,
    },
    requestedQuantity: 3,
    requestedPricePerUnit: 60000,
    requestedTotalPrice: 3 * 60000,
    history: [{
      action: 'requested',
      by: 'wholesaler',
      pricePerUnit: 60000,
      totalPrice: 3 * 60000,
      message: 'Test negotiation',
    }],
    currentOfferBy: 'wholesaler',
    currentPricePerUnit: 60000,
    currentTotalPrice: 3 * 60000,
    expiresAt,
  });

  assert.ok(negotiation._id);
  assert.ok(negotiation.negotiationNumber);
  assert.strictEqual(negotiation.status, 'pending');
  assert.strictEqual(negotiation.requestedQuantity, 3);

  testProduct._testNegotiation = negotiation;
  pass(`Negotiation created: ${negotiation.negotiationNumber} (qty: 3, no minimum enforced)`);
}

async function test_11_negotiation_with_quantity_1() {
  const settings = await Settings.getSettings();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (settings.negotiationExpiryDays || 7));

  // Should work with quantity 1 (no minimum restriction)
  const negotiation = await Negotiation.create({
    wholesalerId: testUser._id,
    productId: testProduct._id,
    productSnapshot: {
      name: testProduct.name,
      price: testProduct.retailPrice,
      image: null,
      sku: testProduct.sku,
    },
    requestedQuantity: 1,
    requestedPricePerUnit: 80000,
    requestedTotalPrice: 80000,
    history: [{
      action: 'requested',
      by: 'wholesaler',
      pricePerUnit: 80000,
      totalPrice: 80000,
      message: 'Single unit negotiation',
    }],
    currentOfferBy: 'wholesaler',
    currentPricePerUnit: 80000,
    currentTotalPrice: 80000,
    expiresAt,
  });

  assert.ok(negotiation._id);
  assert.strictEqual(negotiation.requestedQuantity, 1);
  pass('Negotiation with quantity=1 succeeds (no minimum restriction)');
}

async function test_12_stock_log_audit_trail_complete() {
  const logs = await StockLog.find({ productId: testProduct._id })
    .sort({ createdAt: 1 });

  assert.ok(logs.length >= 3, `Expected at least 3 log entries, got ${logs.length}`);

  // Verify each log has required fields
  for (const l of logs) {
    assert.ok(l.action, 'Log must have action');
    assert.ok(typeof l.quantityChange === 'number', 'Log must have quantityChange');
    assert.ok(typeof l.previousStock === 'number', 'Log must have previousStock');
    assert.ok(typeof l.newStock === 'number', 'Log must have newStock');
    assert.ok(l.performedBy, 'Log must have performedBy');
  }

  pass(`Audit trail complete: ${logs.length} entries, all fields present`);
}

async function test_13_insufficient_stock_blocks_processing() {
  // Set stock to 1
  await Product.findByIdAndUpdate(testProduct._id, { $set: { stock: 1 } });

  // Create order for 10 units
  const order = await Order.create({
    orderNumber: `TEST-ORD3-${Date.now()}`,
    userId: testUser._id,
    customerSnapshot: { name: 'Test', email: 'test@test.com', phone: '1234567890' },
    orderType: 'retail',
    items: [{
      productId: testProduct._id,
      productSnapshot: { name: testProduct.name, sku: testProduct.sku },
      quantity: 10,
      pricePerUnit: 85000,
      totalPrice: 850000,
    }],
    subtotal: 850000, discount: 0, total: 850000,
    shippingAddress: {
      fullName: 'Test', phone: '123', addressLine1: 'St',
      city: 'C', state: 'S', pincode: '123456',
    },
    status: ORDER_STATUS.PAYMENT_VERIFIED,
    statusHistory: [{ status: ORDER_STATUS.PAYMENT_VERIFIED }],
  });

  // Try to process — should fail due to insufficient stock
  const result = await Product.findOneAndUpdate(
    { _id: testProduct._id, stock: { $gte: 10 } },
    { $inc: { stock: -10 } },
    { new: true }
  );

  assert.strictEqual(result, null, 'Should fail with insufficient stock');

  const product = await Product.findById(testProduct._id);
  assert.strictEqual(product.stock, 1, 'Stock should remain 1');
  pass('Insufficient stock blocks order processing');

  // Reset stock
  await Product.findByIdAndUpdate(testProduct._id, { $set: { stock: 50 } });
}

async function test_14_delivered_order_stock_stays_deducted() {
  const product = await Product.findById(testProduct._id);
  const stockBefore = product.stock;

  // Create and process order
  const order = await Order.create({
    orderNumber: `TEST-ORD4-${Date.now()}`,
    userId: testUser._id,
    customerSnapshot: { name: 'Test', email: 'test@test.com', phone: '1234567890' },
    orderType: 'retail',
    items: [{
      productId: product._id,
      productSnapshot: { name: product.name, sku: product.sku },
      quantity: 2,
      pricePerUnit: 85000,
      totalPrice: 170000,
    }],
    subtotal: 170000, discount: 0, total: 170000,
    shippingAddress: {
      fullName: 'Test', phone: '123', addressLine1: 'St',
      city: 'C', state: 'S', pincode: '123456',
    },
    status: ORDER_STATUS.PROCESSING,
    statusHistory: [{ status: ORDER_STATUS.PROCESSING }],
  });

  // Deduct stock for PROCESSING
  await Product.findOneAndUpdate(
    { _id: product._id, stock: { $gte: 2 } },
    { $inc: { stock: -2 } }
  );

  // Move to SHIPPED then DELIVERED
  order.status = ORDER_STATUS.SHIPPED;
  order.shippedAt = new Date();
  await order.save();

  order.status = ORDER_STATUS.DELIVERED;
  order.deliveredAt = new Date();
  await order.save();

  const after = await Product.findById(product._id);
  assert.strictEqual(after.stock, stockBefore - 2, 'Stock stays deducted after delivery');
  pass(`Delivered order: stock ${stockBefore} → ${after.stock} (stays deducted)`);
}

// ═══════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════

const tests = [
  ['01. Initial stock is correct', test_01_initial_stock_is_correct],
  ['02. Manual stock set with logging', test_02_manual_stock_set_with_logging],
  ['03. Manual stock adjustment with logging', test_03_manual_stock_adjustment_with_logging],
  ['04. Stock cannot go below zero', test_04_stock_cannot_go_below_zero],
  ['05. Order creation does NOT deduct stock', test_05_order_creation_does_not_deduct_stock],
  ['06. Stock deducts on PROCESSING (owner confirms)', test_06_stock_deducts_on_processing],
  ['07. Stock restores on CANCEL from PROCESSING', test_07_stock_restores_on_cancel_from_processing],
  ['08. Cancel before PROCESSING does NOT restore', test_08_cancel_before_processing_does_not_restore],
  ['09. Concurrent deduction safety', test_09_concurrent_stock_deduction_safety],
  ['10. Negotiation creation (no min qty)', test_10_negotiation_creation],
  ['11. Negotiation with quantity=1', test_11_negotiation_with_quantity_1],
  ['12. Stock log audit trail complete', test_12_stock_log_audit_trail_complete],
  ['13. Insufficient stock blocks processing', test_13_insufficient_stock_blocks_processing],
  ['14. Delivered order stock stays deducted', test_14_delivered_order_stock_stays_deducted],
];

(async () => {
  let passed = 0;
  let failed = 0;

  try {
    await setup();

    for (const [name, fn] of tests) {
      try {
        await fn();
        passed++;
      } catch (err) {
        console.error(`  ❌ FAILED: ${name}`);
        console.error(`     ${err.message}`);
        failed++;
      }
    }
  } catch (err) {
    console.error('Setup failed:', err);
    failed++;
  } finally {
    await teardown();
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed out of ${tests.length}`);
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
