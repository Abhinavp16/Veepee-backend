const crypto = require('crypto');
const { ShareLink } = require('../models');
const { ORDER_STATUS } = require('../utils/constants');

// After a wholesaler sends a price request or places an order, the app opens
// WhatsApp on OXON's chat with these details typed in (they tap Send).

const DEFAULT_NUMBER = '917828832346';
const LINK_DAYS = 30;
// Longer lists end with "+N more (see PDF)", so the message stays short.
const MAX_LINES = 15;

/**
 * "917828832346" from "+91 78288 32346", "078288 32346" or "7828832346";
 * null when it isn't a phone number.
 */
const normalizeWhatsAppNumber = (value) => {
  const digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
  const full = digits.length === 10 ? `91${digits}` : digits;
  return /^\d{11,15}$/.test(full) ? full : null;
};

/** The admin's WhatsApp alert settings, with the defaults filled in. */
const alertSettings = (settings) => {
  const saved = settings?.whatsappAlerts || {};
  return {
    enabled: saved.enabled !== false,
    number: normalizeWhatsAppNumber(saved.number) || DEFAULT_NUMBER,
    negotiations: saved.negotiations !== false,
    orders: saved.orders !== false,
  };
};

// "₹1,24,000" or "₹2,850.50".
const rupees = (value) => {
  const amount = Number(value || 0);
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount)}`;
};

const dateTime = (value) => new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
}).format(new Date(value || Date.now()));

/** "Wahid Wholesale · Wahid Agro Traders · 9812345671" */
const whoLine = (wholesaler) => [
  wholesaler?.name,
  wholesaler?.businessInfo?.businessName,
  wholesaler?.phone,
].filter(Boolean).join(' · ');

const capped = (lines) => (lines.length > MAX_LINES
  ? [...lines.slice(0, MAX_LINES), `+${lines.length - MAX_LINES} more (see PDF)`]
  : lines);

/**
 * The message for a price request: one negotiation, or every line of a
 * requirement ([members], oldest first).
 */
const requestMessage = ({ members, wholesaler, pdfUrl }) => {
  const first = members[0];
  const number = first.requestGroup?.number || first.negotiationNumber;
  const total = members.reduce((sum, n) => sum + Number(n.requestedTotalPrice || 0), 0);
  const lines = members.map((n, index) => {
    const sku = n.productSnapshot?.sku ? ` (SKU ${n.productSnapshot.sku})` : '';
    const list = Number(n.productSnapshot?.price) > 0 ? ` (list ${rupees(n.productSnapshot.price)})` : '';
    return `${index + 1}. ${n.productSnapshot?.name || 'Product'}${sku}: ${n.requestedQuantity} × ${rupees(n.requestedPricePerUnit)} asked${list} = ${rupees(n.requestedTotalPrice)}`;
  });
  return [
    `*New price request ${number}*`,
    whoLine(wholesaler),
    ...capped(lines),
    `Total asked: ${rupees(total)}`,
    ...(first.message ? [`Note: "${first.message}"`] : []),
    dateTime(first.createdAt),
    ...(pdfUrl ? [`PDF: ${pdfUrl}`] : []),
    '— sent from the OXON app',
  ].join('\n');
};

const PAYMENT_LABELS = {
  [ORDER_STATUS.PENDING_PAYMENT]: 'Awaiting payment',
  [ORDER_STATUS.PAYMENT_UPLOADED]: 'Payment screenshot uploaded',
  [ORDER_STATUS.CANCELLED]: 'Order cancelled',
};

/** The message for a wholesaler's order. */
const orderMessage = ({ order, wholesaler, pdfUrl }) => {
  const lines = (order.items || []).map((item, index) => (
    `${index + 1}. ${item.productSnapshot?.name || 'Product'}: ${item.quantity} × ${rupees(item.pricePerUnit)} = ${rupees(item.totalPrice)}`
  ));
  const amounts = [
    ...(Number(order.discount) > 0 ? [`Discount: −${rupees(order.discount)}`] : []),
    `Delivery: ${Number(order.deliveryFee) > 0 ? rupees(order.deliveryFee) : 'Free'}`,
    ...(Number(order.extraDiscount) > 0 ? [`Extra discount: −${rupees(order.extraDiscount)}`] : []),
    `Total: ${rupees(order.total)}`,
  ];
  const place = [order.shippingAddress?.city, order.shippingAddress?.state].filter(Boolean).join(', ');
  return [
    `*New order ${order.orderNumber}*`,
    whoLine(wholesaler),
    ...capped(lines),
    ...amounts,
    `Payment: ${PAYMENT_LABELS[order.status] || 'Paid'}`,
    ...(place ? [`Deliver to: ${place}`] : []),
    ...(order.customerNote ? [`Note: "${order.customerNote}"`] : []),
    dateTime(order.createdAt),
    ...(pdfUrl ? [`PDF: ${pdfUrl}`] : []),
    '— sent from the OXON app',
  ].join('\n');
};

/** The private PDF link for [kind]/[ref]: the existing one, or a new one. */
const pdfLinkToken = async ({ kind, ref, wholesalerId }) => {
  const existing = await ShareLink.findOne({ kind, ref: String(ref), expiresAt: { $gt: new Date() } }).lean();
  if (existing) return existing.token;
  const link = await ShareLink.create({
    token: crypto.randomBytes(18).toString('base64url'),
    kind,
    ref: String(ref),
    wholesalerId,
    expiresAt: new Date(Date.now() + LINK_DAYS * 24 * 60 * 60 * 1000),
  });
  return link.token;
};

module.exports = {
  DEFAULT_NUMBER,
  MAX_LINES,
  normalizeWhatsAppNumber,
  alertSettings,
  requestMessage,
  orderMessage,
  pdfLinkToken,
};
