const mongoose = require('mongoose');
const { Negotiation, Order, Settings, ShareLink, User } = require('../models');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { loadGroup } = require('../services/requirementGroupService');
const {
  alertSettings, requestMessage, orderMessage, pdfLinkToken,
} = require('../services/oxonWhatsAppService');
const { sendPriceRequestPdf } = require('../utils/priceRequestPdf');
const { sendOrderReceipt, isReceiptAvailable } = require('../utils/orderReceiptPdf');

// The API's public address, for links that open outside the app.
const publicApiBase = (req) => {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  const host = req.get('host');
  const proto = /^(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/.test(host)
    ? 'http'
    : (req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
  return `${proto}://${host}/api/v1`;
};

const notFound = () => new NotFoundError('Not found', 'NOT_FOUND');

/** The price request lines and the link kind for [type]/[id], owned by [userId]. */
const loadRequest = async (type, id, userId) => {
  if (type === 'requirement') {
    const members = await loadGroup(String(id), { wholesalerId: userId });
    return { members, kind: 'requirement', ref: String(id) };
  }
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const negotiation = await Negotiation.findOne({ _id: id, wholesalerId: userId });
  if (!negotiation) throw notFound();
  // One line of a requirement stands for the whole requirement.
  if (negotiation.requestGroup?.id) return loadRequest('requirement', negotiation.requestGroup.id, userId);
  return { members: [negotiation], kind: 'negotiation', ref: String(negotiation._id) };
};

/**
 * GET /whatsapp-alert?type=negotiation|requirement|order&id= — after a
 * wholesaler sends a price request or places an order: OXON's WhatsApp
 * number and the message to send it, with a link to the PDF. `enabled` is
 * false when admin has switched these off.
 */
exports.getAlert = async (req, res, next) => {
  try {
    const { type, id } = req.query;
    if (!['negotiation', 'requirement', 'order'].includes(type) || !id) {
      throw new BadRequestError('type and id are required', 'VALIDATION_ERROR');
    }
    const alerts = alertSettings(await Settings.getSettings());
    if (!alerts.enabled || !(type === 'order' ? alerts.orders : alerts.negotiations)) {
      return res.json({ success: true, data: { enabled: false } });
    }

    const wholesaler = req.user;
    let text;
    if (type === 'order') {
      if (!mongoose.isValidObjectId(id)) throw notFound();
      const order = await Order.findOne({ _id: id, userId: wholesaler._id }).lean();
      if (!order) throw notFound();
      const token = await pdfLinkToken({ kind: 'order', ref: String(order._id), wholesalerId: wholesaler._id });
      text = orderMessage({ order, wholesaler, pdfUrl: `${publicApiBase(req)}/s/${token}` });
    } else {
      const { members, kind, ref } = await loadRequest(type, id, wholesaler._id);
      const token = await pdfLinkToken({ kind, ref, wholesalerId: wholesaler._id });
      text = requestMessage({ members, wholesaler, pdfUrl: `${publicApiBase(req)}/s/${token}` });
    }

    res.json({ success: true, data: { enabled: true, number: alerts.number, text } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /s/:token — the PDF behind a private link from a WhatsApp message:
 * the price request, or the order (a summary until OXON confirms it).
 * Anyone with the link can open it, for 30 days.
 */
exports.getSharedPdf = async (req, res, next) => {
  try {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
    const link = /^[\w-]{16,64}$/.test(req.params.token)
      ? await ShareLink.findOne({ token: req.params.token, expiresAt: { $gt: new Date() } }).lean()
      : null;
    const gone = () => res.status(404).type('text/plain').send('This link has expired or does not exist.');
    if (!link) return gone();

    const [wholesaler, settings] = await Promise.all([
      User.findById(link.wholesalerId).select('name phone businessInfo').lean(),
      Settings.getSettings(),
    ]);

    if (link.kind === 'order') {
      const order = await Order.findById(link.ref);
      if (!order) return gone();
      return sendOrderReceipt(res, order, settings, { summary: !isReceiptAvailable(order) });
    }
    const members = link.kind === 'requirement'
      ? await Negotiation.find({ 'requestGroup.id': link.ref }).sort({ createdAt: 1, _id: 1 }).lean()
      : await Negotiation.find({ _id: link.ref }).lean();
    if (members.length === 0) return gone();
    return sendPriceRequestPdf(res, { members, wholesaler, settings });
  } catch (error) {
    next(error);
  }
};
