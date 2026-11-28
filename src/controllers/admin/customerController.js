const crypto = require('crypto');
const { User, Order, Negotiation, RefreshToken, NotificationCampaign } = require('../../models');
const notificationService = require('../../services/notificationService');
const { sendCustomNotification, countRecipients } = require('../../services/customNotificationService');
const { claimOpenRequest, releaseClaim, openRequestedAt, historyFor } = require('../../services/passwordResetRequestService');
const { NotFoundError, BadRequestError, ConflictError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
const { withSignedProofs, withoutProofs, proofsForViewer } = require('../../services/proofStorage');
const { USER_ROLES, PAID_ORDER_STATUSES } = require('../../utils/constants');

const customerRoles = [USER_ROLES.BUYER, USER_ROLES.WHOLESALER];
// Deleted accounts are not customers any more (see Deletion Requests).
const customerQuery = { role: { $in: customerRoles }, deletedAt: null };
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getCustomers = async (req, res, next) => {
  try {
    const { role, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = { ...customerQuery };
    if (customerRoles.includes(role)) query.role = role;
    if (search) {
      // Typed text is matched as text ("+91" or "(" no longer break it).
      const pattern = new RegExp(escapeRegex(search), 'i');
      query.$or = [
        { name: pattern },
        { email: pattern },
        { phone: pattern },
        { 'businessInfo.businessName': pattern },
      ];
    }

    const [customers, total] = await Promise.all([
      User.find(query)
        .select('-fcmTokens')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      // Proof photos are only in a customer's details (as signed links).
      ...formatPaginationResponse(customers.map(withoutProofs), total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getCustomerById = async (req, res, next) => {
  try {
    // Plain object: spread below, a Mongoose document would lose its fields.
    const customer = await User.findOne({ _id: req.params.id, ...customerQuery }).select('-fcmTokens').lean();

    if (!customer) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }

    const [orderStats, negotiationStats] = await Promise.all([
      Order.aggregate([
        { $match: { userId: customer._id } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            // Only money actually received (payment verified onwards).
            totalSpent: { $sum: { $cond: [{ $in: ['$status', PAID_ORDER_STATUSES] }, '$total', 0] } },
          },
        },
      ]),
      Negotiation.aggregate([
        { $match: { wholesalerId: customer._id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const [recentOrders, passwordResetRequestedAt, passwordResetRequests] = await Promise.all([
      Order.find({ userId: customer._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('orderNumber total status createdAt'),
      openRequestedAt(customer._id),
      historyFor(customer._id, 5),
    ]);

    res.json({
      success: true,
      data: {
        // Proof photos: signed links for admins, left out for staff.
        ...(await proofsForViewer(customer, req.user)),
        openNegotiations: (negotiationStats.find((n) => n._id === 'pending')?.count || 0)
          + (negotiationStats.find((n) => n._id === 'countered')?.count || 0),
        stats: {
          orders: orderStats[0] ? { totalOrders: orderStats[0].totalOrders, totalSpent: orderStats[0].totalSpent } : { totalOrders: 0, totalSpent: 0 },
          negotiations: negotiationStats.reduce((acc, n) => {
            acc[n._id] = n.count;
            return acc;
          }, {}),
        },
        recentOrders,
        // When the customer's open "forgot password" request was made.
        passwordResetRequestedAt,
        // Their latest requests: when asked, and when reset.
        passwordResetRequests,
      },
    });
  } catch (error) {
    next(error);
  }
};

// A one-time password from support works for this long.
const TEMP_PASSWORD_HOURS = 24;

/**
 * POST /admin/customers/:id/reset-password: for a customer who forgot their
 * password and called OXON from their registered number. Issues a one-time
 * password (e.g. OX-482917, 24 hours), signs them out everywhere, and the
 * app makes them choose a new password when they sign in with it.
 */
exports.resetCustomerPassword = async (req, res, next) => {
  try {
    const customer = await User.findOne({ _id: req.params.id, ...customerQuery }).select('+passwordHash');
    if (!customer) throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    // Only when the customer asked from the app in the last 24 hours; each
    // request allows one reset.
    const request = await claimOpenRequest(customer._id, req.user);
    if (!request) {
      throw new ConflictError(
        'The customer has not asked for a reset. Ask them to tap Forgot Password in the app and send the request.',
        'NO_RESET_REQUEST'
      );
    }

    const digits = crypto.randomInt(0, 100000000).toString().padStart(8, '0');
    const temporaryPassword = `OX-${digits.slice(0, 4)}-${digits.slice(4)}`;
    const expiresAt = new Date(Date.now() + TEMP_PASSWORD_HOURS * 60 * 60 * 1000);
    customer.passwordHash = temporaryPassword;
    customer.mustChangePassword = true;
    customer.tempPasswordExpiresAt = expiresAt;
    customer.tempPasswordFailures = 0;
    // Access tokens issued before this stop working too (see protect).
    customer.passwordChangedAt = new Date();
    customer.passwordResets.push({ at: new Date(), by: req.user._id, byName: req.user.name || '' });
    try {
      await customer.save();
    } catch (error) {
      await releaseClaim(request._id);
      throw error;
    }
    await RefreshToken.updateMany({ userId: customer._id, isRevoked: false }, { isRevoked: true });

    notificationService
      .sendLocalizedToUser(customer._id, 'passwordResetBySupport', {}, { type: 'account_update', event: 'PASSWORD_RESET' })
      .catch((error) => console.error('Password reset notification failed:', error.message));

    res.json({
      success: true,
      message: 'One-time password issued. The customer is signed out everywhere.',
      data: { temporaryPassword, expiresAt, passwordResets: customer.passwordResets },
    });
  } catch (error) {
    next(error);
  }
};

const OPEN_NEGOTIATION = ['pending', 'countered'];

/**
 * PUT /admin/customers/:id/account-type — switch a wholesaler back to a
 * customer, or make a customer a wholesaler without an application. Prices
 * follow at once (the role is read on every request); orders and open
 * negotiations are left as they are, and the open ones are counted for admin.
 */
exports.updateCustomerAccountType = async (req, res, next) => {
  try {
    const { accountType } = req.body;
    const reason = String(req.body.reason || '').trim() || null;
    const shared = Boolean(req.body.showReasonToCustomer && reason);

    const customer = await User.findOne({ _id: req.params.id, ...customerQuery });
    if (!customer) throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');

    const from = customer.role;
    const now = new Date();
    if (!customer.businessInfo) customer.businessInfo = {};
    const info = customer.businessInfo;

    if (accountType === 'customer') {
      if (from !== USER_ROLES.WHOLESALER) {
        throw new BadRequestError('This account is already a customer', 'NOT_A_WHOLESALER');
      }
      customer.role = USER_ROLES.BUYER;
      // Business details and documents stay, for when they apply again.
      info.status = 'removed';
      info.verified = false;
      info.removedAt = now;
      info.removalReason = reason;
      info.removalReasonShared = shared;
    } else {
      if (from !== USER_ROLES.BUYER) {
        throw new BadRequestError('This account is already a wholesaler', 'ALREADY_WHOLESALER');
      }
      customer.role = USER_ROLES.WHOLESALER;
      info.status = 'accepted';
      info.verified = true;
      info.verifiedAt = now;
    }

    const openNegotiations = await Negotiation.countDocuments({
      wholesalerId: customer._id,
      status: { $in: OPEN_NEGOTIATION },
    });
    customer.accountTypeHistory.push({
      from,
      to: customer.role,
      at: now,
      by: req.user._id,
      byName: req.user.name || '',
      reason,
      reasonShared: shared,
      openNegotiations,
    });
    await customer.save();

    const template = accountType === 'customer'
      ? (shared ? 'accountSwitchedToCustomerReason' : 'accountSwitchedToCustomer')
      : 'accountSwitchedToWholesaler';
    notificationService
      .sendLocalizedToUser(customer._id, template, { reason }, { type: 'account_update', event: 'ROLE_UPDATED', role: customer.role })
      .catch((error) => console.error('Account type notification failed:', error.message));

    const plain = await withSignedProofs(customer.toObject());
    delete plain.fcmTokens;
    delete plain.passwordHash;
    res.json({
      success: true,
      message: accountType === 'customer' ? 'Switched to a customer account' : 'Switched to a wholesaler account',
      data: { ...plain, openNegotiations },
    });
  } catch (error) {
    next(error);
  }
};

const formatIndiaDate = (value) => new Date(value).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

/** "This application was already handled by Asha on 21 Nov 2026." */
const alreadyHandledMessage = (info = {}) => {
  if (info?.status === 'removed') {
    return `This application was already handled: wholesale access was removed${info.removedAt ? ` on ${formatIndiaDate(info.removedAt)}` : ''}.`;
  }
  const by = info?.reviewedBy?.name;
  const at = info?.reviewedAt;
  if (!by && !at) return 'This application was already handled.';
  return `This application was already handled${by ? ` by ${by}` : ''}${at ? ` on ${formatIndiaDate(at)}` : ''}.`;
};

exports.upgradeCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    // Only a waiting application is decided, in one step, so two admins (or
    // a double tap) can't both decide it.
    const now = new Date();
    const decision = action === 'accept'
      ? { role: USER_ROLES.WHOLESALER, 'businessInfo.status': 'accepted', 'businessInfo.verified': true, 'businessInfo.verifiedAt': now }
      // Details are kept so admin sees the history and the customer can apply again.
      : { 'businessInfo.status': 'rejected', 'businessInfo.verified': false };
    const customer = await User.findOneAndUpdate(
      { $and: [{ _id: id }, customerQuery, applicationFilters.pending] },
      {
        $set: {
          ...decision,
          // Who decided, and when (admin only; see sanitizeUser).
          'businessInfo.reviewedAt': now,
          'businessInfo.reviewedBy': { id: req.user._id, name: req.user.name || '' },
        },
      },
      { new: true, runValidators: true }
    );

    if (!customer) {
      const existing = await User.findOne({ _id: id, ...customerQuery }).select('businessInfo').lean();
      if (!existing) throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
      throw new ConflictError(alreadyHandledMessage(existing.businessInfo), 'APPLICATION_NOT_PENDING');
    }

    if (customer.fcmTokens && customer.fcmTokens.length > 0) {
      const { getMessaging } = require('../../config/firebase');
      const messaging = getMessaging();
      if (messaging) {
        const payload = {
          notification: {
            title: action === 'accept' ? 'Account Upgraded! 🎉' : 'Application Update',
            body: action === 'accept' 
              ? 'Your wholesaler account has been approved. Enjoy exclusive bulk access!' 
              : 'Your wholesaler application was not approved. Please review your details and re-apply from your profile.',
          },
          data: {
            type: 'ROLE_UPDATED',
            action: action
          },
          tokens: customer.fcmTokens,
        };
        try {
          await messaging.sendEachForMulticast(payload);
        } catch (fcmErr) {
          console.error('FCM Notification error:', fcmErr);
        }
      }
    }

    const plain = customer.toObject();
    delete plain.fcmTokens;
    delete plain.passwordHash;
    res.json({
      success: true,
      message: `Customer application ${action}ed successfully.`,
      data: await withSignedProofs(applicationView(plain)),
    });
  } catch (error) {
    next(error);
  }
};

// Wholesaler applications (Account Upgrades), by businessInfo.status.
const APPLICATION_STATUSES = ['pending', 'accepted', 'rejected', 'removed'];
const applicationFilters = {
  // Also customers from before application statuses existed: a business
  // name and no status at all.
  pending: {
    $or: [
      { 'businessInfo.status': 'pending' },
      { role: USER_ROLES.BUYER, 'businessInfo.status': null, 'businessInfo.businessName': { $nin: [null, ''] } },
    ],
  },
  accepted: { 'businessInfo.status': 'accepted' },
  rejected: { 'businessInfo.status': 'rejected' },
  removed: { 'businessInfo.status': 'removed' },
};
// Newest first: when they applied (pending), were decided on (accepted,
// rejected) or removed; older records without these use their last update.
const applicationSortKeys = {
  pending: ['$businessInfo.appliedAt'],
  accepted: ['$businessInfo.reviewedAt', '$businessInfo.verifiedAt', '$businessInfo.appliedAt'],
  rejected: ['$businessInfo.reviewedAt', '$businessInfo.appliedAt'],
  removed: ['$businessInfo.removedAt'],
};
const APPLICATION_FIELDS = ['name', 'email', 'phone', 'role', 'isActive', 'businessInfo', 'createdAt', 'updatedAt'];

/** What admin sees of an applicant (no password, tokens or saved data). */
const applicationView = (user) => {
  const view = { _id: user._id };
  for (const field of APPLICATION_FIELDS) view[field] = user[field];
  const status = user.businessInfo?.status;
  // The status the list files it under (older records have none).
  view.applicationStatus = APPLICATION_STATUSES.includes(status) ? status : 'pending';
  return view;
};

/**
 * GET /admin/wholesaler-applications?status=pending|accepted|rejected|removed
 * &search=&page=&limit= (admin only). Newest first, with the number in each
 * status; proof photos are signed links that work for 15 minutes.
 */
exports.getWholesalerApplications = async (req, res, next) => {
  try {
    const status = APPLICATION_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    const search = String(req.query.search || '').trim();
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const conditions = [customerQuery, applicationFilters[status]];
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      conditions.push({
        $or: [
          { name: pattern },
          { email: pattern },
          { phone: pattern },
          { 'businessInfo.businessName': pattern },
          { 'businessInfo.gstNumber': pattern },
          { 'businessInfo.contactPerson': pattern },
          { 'businessInfo.contactPhone': pattern },
        ],
      });
    }
    const match = { $and: conditions };
    const sortAt = applicationSortKeys[status].reduceRight((fallback, key) => ({ $ifNull: [key, fallback] }), '$updatedAt');
    const projection = Object.fromEntries(APPLICATION_FIELDS.map((field) => [field, 1]));

    const [items, total, ...counts] = await Promise.all([
      User.aggregate([
        { $match: match },
        { $addFields: { sortAt } },
        { $sort: { sortAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: projection },
      ]),
      User.countDocuments(match),
      ...APPLICATION_STATUSES.map((key) => User.countDocuments({ $and: [customerQuery, applicationFilters[key]] })),
    ]);

    const data = await Promise.all(items.map((item) => withSignedProofs(applicationView(item))));
    res.json({
      success: true,
      ...formatPaginationResponse(data, total, page, limit),
      counts: Object.fromEntries(APPLICATION_STATUSES.map((key, index) => [key, counts[index]])),
    });
  } catch (error) {
    next(error);
  }
};

// Custom notification (Customers page): see services/customNotificationService.

// POST /admin/customers/notifications
exports.sendNotification = async (req, res, next) => {
  try {
    const { message, data } = await sendCustomNotification(req.body, req.user);
    res.json({ success: true, message, data });
  } catch (error) {
    next(error);
  }
};

// POST /admin/customers/notifications/count: { people, phones } it would reach.
exports.notificationCount = async (req, res, next) => {
  try {
    res.json({ success: true, data: await countRecipients(req.body) });
  } catch (error) {
    next(error);
  }
};

// GET /admin/customers/notifications/history?page=&limit=: newest first.
exports.notificationHistory = async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const [items, total] = await Promise.all([
      NotificationCampaign.find({}).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      NotificationCampaign.countDocuments({}),
    ]);
    res.json({ success: true, ...formatPaginationResponse(items, total, page, limit) });
  } catch (error) {
    next(error);
  }
};
// Download links for a customer's wholesaler proof photos (administrators):
// "sharma-traders-9812345671-proof-1.webp" and so on.
exports.downloadProofs = async (req, res, next) => {
  try {
    const { downloadLinks, fileSlug } = require('../../services/fileDownloads');
    const { PROOF_PREFIX } = require('../../services/proofStorage');
    const customer = await User.findOne({ _id: req.params.id, ...customerQuery })
      .select('name phone businessInfo.businessName businessInfo.proofImages')
      .lean();
    if (!customer) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }
    const proofs = customer.businessInfo?.proofImages || [];
    const phone = String(customer.phone || '').replace(/\D/g, '').slice(-15);
    const who = [fileSlug(customer.businessInfo?.businessName || customer.name, 'customer'), phone]
      .filter(Boolean)
      .join('-');
    const data = await downloadLinks(
      proofs.map((url, index) => ({ url, name: `${who}-proof-${index + 1}` })),
      PROOF_PREFIX
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
