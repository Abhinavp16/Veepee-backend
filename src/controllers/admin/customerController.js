const { User, Order, Negotiation, DeviceToken, Notification } = require('../../models');
const notificationService = require('../../services/notificationService');
const mongoose = require('mongoose');
const { NotFoundError, BadRequestError } = require('../../utils/errors');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');
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
      ...formatPaginationResponse(customers, total, page, limit),
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

    const recentOrders = await Order.find({ userId: customer._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('orderNumber total status createdAt');

    res.json({
      success: true,
      data: {
        ...customer,
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
      },
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

    const plain = customer.toObject();
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

exports.upgradeCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const customer = await User.findOne({ _id: id, ...customerQuery });

    if (!customer) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }

    if (action === 'accept') {
      customer.role = 'wholesaler';
      if (customer.businessInfo) {
        customer.businessInfo.status = 'accepted';
        customer.businessInfo.verified = true;
        customer.businessInfo.verifiedAt = new Date();
      }
    } else if (action === 'reject') {
      if (customer.businessInfo) {
        customer.businessInfo.status = 'rejected';
        customer.businessInfo.verified = false;
        // Keep data so admin can see history and user can see rejection details
      }
    }

    await customer.save();

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

    res.json({
      success: true,
      message: `Customer application ${action}ed successfully.`
    });
  } catch (error) {
    next(error);
  }
};

// Sends the admin's message to the selected people: always saved in their
// in-app inbox, and pushed to every phone they are signed in on.
exports.sendNotification = async (req, res, next) => {
  try {
    const { title, body } = req.body;
    const requested = [...new Set(req.body.userIds.map(String))]
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const users = await User.find({ _id: { $in: requested }, isActive: { $ne: false } }).select('_id').lean();
    const userIds = users.map((user) => user._id);
    if (userIds.length === 0) {
      throw new BadRequestError('None of the selected people can receive notifications', 'NO_RECIPIENTS');
    }

    const data = { type: 'custom_admin_notification' };
    await Notification.insertMany(userIds.map((userId) => ({
      userId, title, body, type: 'general', data,
    })));

    const tokens = await DeviceToken.find({ userId: { $in: userIds }, isActive: true }).select('fcmToken').lean();
    const fcmTokens = [...new Set(tokens.map((t) => t.fcmToken))];
    let delivered = 0;
    let failed = 0;
    let pushConfigured = Boolean(notificationService.getMessagingInstance());
    if (pushConfigured && fcmTokens.length > 0) {
      const result = await notificationService.sendToMultipleDevices(fcmTokens, { title, body }, data);
      if (result === null) {
        pushConfigured = false;
      } else {
        delivered = result.successCount || 0;
        failed = result.failureCount || 0;
      }
    }

    const people = `${userIds.length} ${userIds.length === 1 ? 'person' : 'people'}`;
    let pushText;
    if (!pushConfigured) pushText = 'push not sent: Firebase is not set up on the server';
    else if (fcmTokens.length === 0) pushText = 'nobody has the app signed in on a phone, so no push was sent';
    else pushText = `push delivered to ${delivered} of ${fcmTokens.length} phones`;

    res.json({
      success: true,
      message: `Saved for ${people} · ${pushText}.`,
      data: {
        saved: userIds.length,
        phones: fcmTokens.length,
        delivered,
        failed,
        pushConfigured,
      },
    });
  } catch (error) {
    next(error);
  }
};

