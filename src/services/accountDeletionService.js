const {
  AccountDeletionRequest,
  Analytics,
  Cart,
  DeviceToken,
  Negotiation,
  Notification,
  Order,
  Payment,
  RefreshToken,
  User,
} = require('../models');
const storageCleanup = require('../utils/storageCleanup');
const { notifyTeam } = require('./adminNotificationService');
const { ORDER_STATUS } = require('../utils/constants');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');

const REQUEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['pending', 'in_review'];
// Orders that are still being paid for, prepared or delivered.
const OPEN_ORDER_STATUSES = [
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PAYMENT_UPLOADED,
  ORDER_STATUS.PAYMENT_VERIFIED,
  ORDER_STATUS.PROCESSING,
  ORDER_STATUS.SHIPPED,
];
const PROTECTED_ROLES = ['admin', 'staff'];

const dateAfter = (milliseconds) => new Date(Date.now() + milliseconds);

async function findActiveRequest(userId) {
  return AccountDeletionRequest.findOne({
    userId,
    status: { $in: ACTIVE_STATUSES },
  }).sort({ createdAt: -1 });
}

function countOpenOrders(userId) {
  return Order.countDocuments({ userId, status: { $in: OPEN_ORDER_STATUSES } });
}

// Open-order counts for many users at once (admin list).
async function openOrderCounts(userIds) {
  if (!userIds.length) return new Map();
  const rows = await Order.aggregate([
    { $match: { userId: { $in: userIds }, status: { $in: OPEN_ORDER_STATUSES } } },
    { $group: { _id: '$userId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

async function createRequestForUser({ user, source }) {
  if (!user || !user.isActive) {
    throw new NotFoundError('Active account not found', 'ACCOUNT_NOT_FOUND');
  }
  if (PROTECTED_ROLES.includes(user.role)) {
    throw new BadRequestError('This account cannot be deleted through this workflow', 'DELETION_REQUEST_INVALID_ACCOUNT');
  }

  const existing = await findActiveRequest(user._id);
  if (existing) {
    return { request: existing, alreadyPending: true };
  }

  const request = await AccountDeletionRequest.create({
    userId: user._id,
    source,
    dueAt: dateAfter(REQUEST_WINDOW_MS),
    events: [{
      action: 'requested',
      byUserId: user._id,
      note: source === 'app'
        ? 'Submitted by the authenticated account holder.'
        : 'Submitted through the public deletion page; identity verification is required.',
    }],
  });

  notifyTeam({
    type: 'deletion_request',
    audience: 'admin',
    title: 'Account deletion request',
    body: `${user.name || 'A customer'} asked to delete their account.`,
    link: '/account-deletion-requests',
    data: { requestId: request._id },
  });

  return { request, alreadyPending: false };
}

async function completeRequest({ requestId, adminUserId, staffNote = '', identityVerified = false }) {
  const request = await AccountDeletionRequest.findById(requestId);
  if (!request) {
    throw new NotFoundError('Deletion request not found', 'DELETION_REQUEST_NOT_FOUND');
  }
  if (!ACTIVE_STATUSES.includes(request.status)) {
    throw new ConflictError('Only pending or in-review requests can be completed', 'DELETION_REQUEST_NOT_ACTIONABLE');
  }

  // A website request needs the admin to confirm they verified the account
  // holder, either earlier (when moving it to review) or now.
  if (request.source === 'website' && !request.identityVerification?.verifiedAt) {
    if (identityVerified !== true) {
      throw new BadRequestError(
        'Confirm that you verified this website request with the account holder before completing it',
        'DELETION_REQUEST_VERIFICATION_REQUIRED'
      );
    }
    request.identityVerification = {
      verifiedAt: new Date(),
      verifiedBy: adminUserId,
      method: 'staff-confirmed',
    };
  }

  const user = await User.findById(request.userId).select('+passwordHash');
  if (!user || PROTECTED_ROLES.includes(user.role)) {
    throw new BadRequestError('The account cannot be processed through this workflow', 'DELETION_REQUEST_INVALID_ACCOUNT');
  }

  const userId = user._id;
  const openOrders = await countOpenOrders(userId);
  if (openOrders > 0) {
    throw new ConflictError(
      `This customer has ${openOrders} order${openOrders === 1 ? '' : 's'} in progress. Complete the deletion after they are delivered or cancelled.`,
      'ACCOUNT_HAS_OPEN_ORDERS'
    );
  }

  const identifier = String(userId);
  const completedAt = new Date();

  // Payment screenshots are removed from storage after the database is updated.
  const screenshotPaths = (await Payment.find({ userId, screenshotPublicId: { $nin: [null, ''] } })
    .select('screenshotPublicId')
    .lean()).map((payment) => payment.screenshotPublicId);

  // Negotiations that produced an order stay (they hold no personal data, only the product and price).
  const linkedNegotiationIds = (await Order.find({ userId, negotiationId: { $ne: null } })
    .select('negotiationId')
    .lean()).map((order) => order.negotiationId);

  await Promise.all([
    Cart.deleteMany({ userId }),
    DeviceToken.deleteMany({ userId }),
    Notification.deleteMany({ userId }),
    RefreshToken.deleteMany({ userId }),
    Negotiation.deleteMany({ wholesalerId: userId, _id: { $nin: linkedNegotiationIds } }),
    Analytics.updateMany({ userId }, { $unset: { userId: 1 } }),
    // Orders and payments are retained for accounting. Name, phone and street
    // address are removed; city, state and pincode stay for tax records.
    Order.updateMany({ userId }, {
      $set: {
        'customerSnapshot.name': 'Deleted customer',
        'customerSnapshot.email': '',
        'customerSnapshot.phone': 'deleted',
        'shippingAddress.fullName': 'Deleted customer',
        'shippingAddress.phone': 'deleted',
        'shippingAddress.addressLine1': 'Removed',
      },
      $unset: {
        'customerSnapshot.businessName': 1,
        'shippingAddress.addressLine2': 1,
      },
    }),
    Payment.updateMany({ userId }, { $set: { screenshotUrl: null, screenshotPublicId: null } }),
  ]);

  user.name = 'Deleted account';
  user.email = `deleted-${identifier}@deleted.invalid`;
  user.phone = `deleted-${identifier}`;
  user.address = null;
  user.savedAddresses = [];
  user.selectedAddressId = null;
  user.avatar = null;
  user.googleId = undefined;
  user.passwordHash = undefined;
  user.fcmTokens = [];
  user.phoneVerified = false;
  user.marketingConsent = false;
  user.consentTimestamp = null;
  user.businessInfo = {
    businessName: null,
    gstNumber: null,
    businessAddress: null,
    contactPerson: null,
    status: 'none',
    verified: false,
    verifiedAt: null,
    proofImages: [],
  };
  user.isActive = false;
  user.deletedAt = completedAt;
  await user.save();

  request.status = 'completed';
  request.completedAt = completedAt;
  request.processedBy = adminUserId;
  request.staffNote = staffNote || null;
  request.events.push({
    action: 'completed',
    byUserId: adminUserId,
    note: 'Account access revoked. Profile, address, cart, device-token, notification, negotiation, avatar, business-proof and payment-screenshot data removed or anonymized. Order and payment records are retained without name, phone or street address.',
  });
  await request.save();

  // Uploaded files go last and are best-effort: the account is already closed.
  await Promise.all([
    storageCleanup.deleteByPrefix(`avatars/${identifier}`),
    storageCleanup.deleteByPrefix(`proofs/${identifier}`),
    ...screenshotPaths.map((path) => storageCleanup.deleteFile(path)),
  ]);

  return request;
}

module.exports = {
  ACTIVE_STATUSES,
  OPEN_ORDER_STATUSES,
  countOpenOrders,
  openOrderCounts,
  createRequestForUser,
  completeRequest,
  findActiveRequest,
};
