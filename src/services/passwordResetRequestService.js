const { PasswordResetRequest } = require('../models');

// A request lets admin reset the password for this long after the customer
// last asked.
const RESET_REQUEST_HOURS = 24;

const openSince = () => new Date(Date.now() - RESET_REQUEST_HOURS * 60 * 60 * 1000);

/** Open: pending and asked within the last 24 hours. */
const openFilter = (extra = {}) => ({ ...extra, status: 'pending', lastRequestedAt: { $gt: openSince() } });

/** 'open', 'completed' or 'expired' (pending, but asked over 24 hours ago). */
const statusOf = (request) => {
  if (request.status === 'completed') return 'completed';
  return request.lastRequestedAt > openSince() ? 'open' : 'expired';
};

/**
 * Records that [customer] asked from the app. Asking again while a request
 * is open keeps that one open longer; returns `created` only for a new one.
 */
const recordRequest = async (customer) => {
  const now = new Date();
  const existing = await PasswordResetRequest.findOneAndUpdate(
    openFilter({ userId: customer._id }),
    { $set: { lastRequestedAt: now, name: customer.name || '', phone: customer.phone || '' } },
    { new: true }
  );
  if (existing) return { request: existing, created: false };
  const request = await PasswordResetRequest.create({
    userId: customer._id,
    name: customer.name || '',
    phone: customer.phone || '',
    role: customer.role || '',
    requestedAt: now,
    lastRequestedAt: now,
  });
  return { request, created: true };
};

/**
 * Takes the customer's open request for a reset by [admin], in one step so
 * two admins can't both use it. Null when there is none.
 */
const claimOpenRequest = (userId, admin) => PasswordResetRequest.findOneAndUpdate(
  openFilter({ userId }),
  { $set: { status: 'completed', completedAt: new Date(), completedBy: admin._id, completedByName: admin.name || '' } },
  { new: true, sort: { lastRequestedAt: -1 } }
);

/** Gives a claimed request back (the reset itself failed). */
const releaseClaim = (requestId) => PasswordResetRequest.updateOne(
  { _id: requestId },
  { $set: { status: 'pending', completedAt: null, completedBy: null, completedByName: '' } }
);

/**
 * A request as admin sees it: when the customer asked, and when (and by
 * whom) the password was reset, or that it lapsed. `userId` is either the
 * loaded account (name, phone, role, deletedAt) or just its id.
 */
const toListItem = (request) => {
  const loaded = Boolean(request.userId) && 'name' in request.userId;
  const account = loaded && !request.userId.deletedAt ? request.userId : null;
  const accountGone = loaded && !account;
  return {
    _id: request._id,
    customerId: accountGone ? null : (account?._id || request.userId),
    // Today's name and number; as asked if the account is gone.
    name: account?.name || request.name,
    phone: account?.phone || request.phone,
    role: account?.role || request.role,
    status: statusOf(request),
    requestedAt: request.requestedAt,
    lastRequestedAt: request.lastRequestedAt,
    // An open request lapses 24 hours after the customer last asked.
    expiresAt: new Date(new Date(request.lastRequestedAt).getTime() + RESET_REQUEST_HOURS * 60 * 60 * 1000),
    completedAt: request.completedAt,
    completedByName: request.completedByName,
  };
};

/** The customer's latest requests, newest first. */
const historyFor = async (userId, limit = 10) => (await PasswordResetRequest.find({ userId })
  .sort({ lastRequestedAt: -1 })
  .limit(limit)
  .lean()).map(toListItem);

/** When the customer's open request was last asked, or null. */
const openRequestedAt = async (userId) => {
  const request = await PasswordResetRequest.findOne(openFilter({ userId }))
    .sort({ lastRequestedAt: -1 }).select('lastRequestedAt').lean();
  return request?.lastRequestedAt || null;
};

module.exports = {
  RESET_REQUEST_HOURS,
  openSince,
  openFilter,
  statusOf,
  recordRequest,
  claimOpenRequest,
  releaseClaim,
  openRequestedAt,
  toListItem,
  historyFor,
};
