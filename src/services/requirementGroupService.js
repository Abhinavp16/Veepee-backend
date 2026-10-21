const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const { Negotiation, Product, Cart, Settings } = require('../models');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { NEGOTIATION_STATUS, NEGOTIATION_ACTIONS, USER_ROLES } = require('../utils/constants');
const { generateRequirementNumber } = require('../utils/helpers');
const { loadDiscountContext, priceFor } = require('./productPricingService');
const { assertPurchasable } = require('../utils/productAvailability');
const { assertQuantityAllowed } = require('../utils/quantityRules');
const notificationService = require('./notificationService');
const { notifyTeam } = require('./adminNotificationService');

const { PENDING, COUNTERED, ACCEPTED, REJECTED, EXPIRED, CONVERTED } = NEGOTIATION_STATUS;

const money = (value) => Math.round(Number(value) * 100) / 100;

/** Rolls a group's lines up into one state for the app and the admin panel. */
const summarizeGroup = (members) => {
  const open = members.filter((m) => ![REJECTED, EXPIRED].includes(m.status));
  const counts = (status) => open.filter((m) => m.status === status).length;
  let status;
  if (open.length === 0) status = REJECTED;
  else if (open.every((m) => m.status === CONVERTED)) status = CONVERTED;
  else if (counts(COUNTERED) > 0) status = COUNTERED;
  else if (counts(PENDING) > 0) status = PENDING;
  else status = ACCEPTED;

  // Payable once nothing is waiting on either side and something is accepted.
  const payableMembers = open.filter((m) => m.status === ACCEPTED && !m.orderId);
  const unresolved = open.some((m) => [PENDING, COUNTERED].includes(m.status));
  return {
    status,
    productCount: members.length,
    totalPrice: money(open.reduce((sum, m) => sum + (m.currentTotalPrice || 0), 0)),
    canPay: !unresolved && payableMembers.length > 0,
    payableCount: payableMembers.length,
    waitingOn: counts(COUNTERED) > 0 ? 'wholesaler' : counts(PENDING) > 0 ? 'dealer' : null,
  };
};

const loadGroup = async (groupId, filter = {}) => {
  const members = await Negotiation.find({ 'requestGroup.id': groupId, ...filter }).sort({ createdAt: 1, _id: 1 });
  if (members.length === 0) throw new NotFoundError('Requirement not found', 'REQUIREMENT_NOT_FOUND');
  return members;
};

/**
 * Sends the whole cart to the dealer as one requirement: one negotiation per
 * line, all-or-nothing. Each line is asked at its current wholesale price
 * unless the wholesaler names their own in `offers`.
 */
const createRequirementFromCart = async ({ user, message, offers = [] }) => {
  const cart = await Cart.findOne({ userId: user._id });
  if (!cart || cart.items.length === 0) {
    throw new BadRequestError('Your cart is empty', 'CART_EMPTY');
  }

  const products = await Product.find({ _id: { $in: cart.items.map((i) => i.productId) } });
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const ctx = await loadDiscountContext(products, { sales: false }); // never sale prices
  const offerFor = new Map(offers.map((o) => [String(o.productId), o.pricePerUnit]));

  const lines = [];
  const issues = [];
  for (const item of cart.items) {
    const product = byId.get(String(item.productId));
    try {
      if (!product) throw new BadRequestError('This product is no longer available', 'PRODUCT_UNAVAILABLE');
      assertPurchasable(product);
      if (!product.negotiationEnabled) {
        throw new BadRequestError(`${product.name} cannot be negotiated`, 'NEGOTIATION_DISABLED');
      }
      assertQuantityAllowed(product, item.quantity, USER_ROLES.WHOLESALER);
      if (product.stock < item.quantity) {
        throw new BadRequestError(`Only ${product.stock} of ${product.name} available`, 'INSUFFICIENT_STOCK');
      }
      const standardPrice = priceFor(product, USER_ROLES.WHOLESALER, ctx).price;
      lines.push({ product, quantity: item.quantity, pricePerUnit: offerFor.get(String(product._id)) ?? standardPrice, standardPrice });
    } catch (error) {
      issues.push({
        productId: String(item.productId),
        name: product?.name || '',
        code: error.code || 'INVALID',
        message: error.message,
      });
    }
  }
  if (issues.length > 0) {
    const error = new BadRequestError('Some products cannot be sent as a requirement', 'REQUIREMENT_INVALID');
    error.details = { items: issues };
    throw error;
  }

  const settings = await Settings.getSettings();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + settings.negotiationExpiryDays);
  const requestGroup = lines.length > 1 ? { id: uuidv4(), number: generateRequirementNumber() } : undefined;

  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      created = [];
      for (const line of lines) {
        const total = line.quantity * line.pricePerUnit;
        const [negotiation] = await Negotiation.create([{
          wholesalerId: user._id,
          productId: line.product._id,
          productSnapshot: {
            name: line.product.name,
            price: line.standardPrice,
            image: line.product.primaryImage,
            sku: line.product.sku,
          },
          requestedQuantity: line.quantity,
          requestedPricePerUnit: line.pricePerUnit,
          requestedTotalPrice: total,
          message,
          history: [{
            action: NEGOTIATION_ACTIONS.REQUESTED,
            by: 'wholesaler',
            pricePerUnit: line.pricePerUnit,
            totalPrice: total,
            message: message || 'Initial request',
          }],
          currentOfferBy: 'wholesaler',
          currentPricePerUnit: line.pricePerUnit,
          currentTotalPrice: total,
          expiresAt,
          ...(requestGroup && { requestGroup }),
        }], { session });
        created.push(negotiation);
      }
      // The requirement now lives in negotiations, so the cart is emptied.
      await Cart.updateOne({ userId: user._id }, { $set: { items: [] } }, { session });
    });
  } finally {
    await session.endSession();
  }

  await Product.updateMany({ _id: { $in: lines.map((l) => l.product._id) } }, { $inc: { negotiationCount: 1 } });
  notifyTeam({
    type: 'new_negotiation',
    title: requestGroup ? 'New requirement' : 'New negotiation request',
    body: requestGroup
      ? `${user.name} sent requirement ${requestGroup.number} with ${lines.length} products.`
      : `${user.name} asked for ${lines[0].quantity} × ${lines[0].product.name} at ₹${lines[0].pricePerUnit} each.`,
    link: '/negotiations',
    data: { negotiationId: created[0]._id, requirementNumber: requestGroup?.number },
  });

  return { requestGroup: requestGroup || null, negotiations: created };
};

const addHistory = (negotiation, by, action, extra = {}) => {
  negotiation.history.push({ action, by, ...extra });
};

const acceptLine = (negotiation, by, message) => {
  addHistory(negotiation, by, NEGOTIATION_ACTIONS.ACCEPTED, {
    pricePerUnit: negotiation.currentPricePerUnit,
    totalPrice: negotiation.currentTotalPrice,
    message,
  });
  negotiation.status = ACCEPTED;
  negotiation.finalPricePerUnit = negotiation.currentPricePerUnit;
  negotiation.finalTotalPrice = negotiation.currentTotalPrice;
};

const rejectLine = (negotiation, by, message) => {
  addHistory(negotiation, by, NEGOTIATION_ACTIONS.REJECTED, { message });
  negotiation.status = REJECTED;
};

const saveAll = (members) => Promise.all(members.filter((m) => m.isModified()).map((m) => m.save()));

/** The wholesaler answers a requirement: accept the dealer's counters, or decline it all. */
const respondAsWholesaler = async ({ user, groupId, action }) => {
  const members = await loadGroup(groupId, { wholesalerId: user._id });

  if (action === 'accept') {
    // Only lines where the dealer's counter is waiting can be accepted; a
    // wholesaler cannot accept their own offer.
    const countered = members.filter((m) => m.status === COUNTERED && m.currentOfferBy === 'admin');
    if (countered.length === 0) {
      throw new BadRequestError('There are no dealer offers to accept', 'NOTHING_TO_ACCEPT');
    }
    countered.forEach((m) => acceptLine(m, 'wholesaler'));
  } else {
    const declinable = members.filter((m) => ![REJECTED, CONVERTED, EXPIRED].includes(m.status));
    if (declinable.length === 0) {
      throw new BadRequestError('This requirement is already closed', 'INVALID_NEGOTIATION_STATUS');
    }
    declinable.forEach((m) => rejectLine(m, 'wholesaler'));
  }
  await saveAll(members);
  return { members, summary: summarizeGroup(members) };
};

/** The dealer (admin or staff) answers a requirement: accept, counter prices, or decline. */
const respondAsDealer = async ({ groupId, action, counters = [], message }) => {
  const members = await loadGroup(groupId);
  const wholesalerId = members[0].wholesalerId;

  if (action === 'accept') {
    const pending = members.filter((m) => m.status === PENDING);
    if (pending.length === 0) {
      throw new BadRequestError('There are no offers waiting to be accepted', 'INVALID_NEGOTIATION_STATUS');
    }
    pending.forEach((m) => acceptLine(m, 'admin', message));
  } else if (action === 'counter') {
    const byId = new Map(members.map((m) => [String(m._id), m]));
    for (const counter of counters) {
      const negotiation = byId.get(String(counter.negotiationId));
      if (!negotiation) {
        throw new NotFoundError('A product in this counter is not part of the requirement', 'NEGOTIATION_NOT_FOUND');
      }
      if (![PENDING, COUNTERED].includes(negotiation.status)) {
        throw new BadRequestError(`${negotiation.productSnapshot.name} can no longer be countered`, 'INVALID_NEGOTIATION_STATUS');
      }
      const total = negotiation.requestedQuantity * counter.pricePerUnit;
      addHistory(negotiation, 'admin', NEGOTIATION_ACTIONS.COUNTERED, { pricePerUnit: counter.pricePerUnit, totalPrice: total, message });
      negotiation.status = COUNTERED;
      negotiation.currentOfferBy = 'admin';
      negotiation.currentPricePerUnit = counter.pricePerUnit;
      negotiation.currentTotalPrice = total;
    }
  } else {
    const open = members.filter((m) => [PENDING, COUNTERED].includes(m.status));
    if (open.length === 0) {
      throw new BadRequestError('This requirement can no longer be declined', 'INVALID_NEGOTIATION_STATUS');
    }
    open.forEach((m) => rejectLine(m, 'admin', message));
  }
  await saveAll(members);

  const summary = summarizeGroup(members);
  const number = members[0].requestGroup.number;
  const template = { accept: 'requirementAccepted', counter: 'requirementCountered', reject: 'requirementDeclined' }[action];
  try {
    await notificationService.sendLocalizedToUser(
      wholesalerId,
      template,
      { requirementNumber: number, count: members.length },
      { type: `negotiation_${action === 'accept' ? 'accepted' : action === 'counter' ? 'countered' : 'rejected'}`, negotiationId: String(members[0]._id), requirementGroupId: groupId }
    );
  } catch (error) {
    console.error('Failed to notify the wholesaler about the requirement:', error.message);
  }
  return { members, summary };
};

module.exports = {
  summarizeGroup,
  loadGroup,
  createRequirementFromCart,
  respondAsWholesaler,
  respondAsDealer,
};
