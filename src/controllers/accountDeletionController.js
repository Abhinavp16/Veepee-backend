const { User, AccountDeletionRequest } = require('../models');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { createRequestForUser, countOpenOrders } = require('../services/accountDeletionService');

const serializeRequest = (request, openOrderCount = 0) => ({
  id: request._id,
  status: request.status,
  source: request.source,
  requestedAt: request.requestedAt,
  dueAt: request.dueAt,
  completedAt: request.completedAt,
  staffNote: request.status === 'rejected' ? request.staffNote : null,
  // Deletion is completed after in-progress orders are delivered or cancelled.
  openOrderCount,
});

exports.getMyRequest = async (req, res, next) => {
  try {
    const request = await AccountDeletionRequest.findOne({ userId: req.user._id })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: request ? serializeRequest(request, await countOpenOrders(req.user._id)) : null,
    });
  } catch (error) {
    next(error);
  }
};

exports.requestMyAccountDeletion = async (req, res, next) => {
  try {
    const { request, alreadyPending } = await createRequestForUser({
      user: req.user,
      source: 'app',
    });

    res.status(alreadyPending ? 200 : 201).json({
      success: true,
      message: alreadyPending
        ? 'Your account deletion request is already being processed.'
        : 'Your account deletion request has been submitted. We will complete it within 30 days.',
      data: serializeRequest(request, await countOpenOrders(req.user._id)),
    });
  } catch (error) {
    next(error);
  }
};

exports.cancelMyAccountDeletion = async (req, res, next) => {
  try {
    const request = await AccountDeletionRequest.findOne({
      userId: req.user._id,
      status: 'pending',
    }).sort({ createdAt: -1 });

    if (!request) {
      throw new NotFoundError('No pending deletion request can be cancelled', 'DELETION_REQUEST_NOT_FOUND');
    }

    request.status = 'cancelled';
    request.events.push({
      action: 'cancelled',
      byUserId: req.user._id,
      note: 'Cancelled by the authenticated account holder before processing.',
    });
    await request.save();

    res.json({
      success: true,
      message: 'Your account deletion request has been cancelled.',
      data: serializeRequest(request),
    });
  } catch (error) {
    next(error);
  }
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.requestDeletionFromWebsite = async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    if (!name || !phone) {
      throw new BadRequestError('Provide your full name and registered mobile number.', 'DELETION_IDENTIFIER_REQUIRED');
    }

    const user = await User.findOne({
      name: new RegExp(`^${escapeRegExp(name)}$`, 'i'),
      phone,
      role: { $in: ['buyer', 'wholesaler'] },
      isActive: true,
    });

    // Same response whether or not an account matches, to avoid account enumeration.
    if (user) {
      await createRequestForUser({ user, source: 'website' });
    }

    res.status(202).json({
      success: true,
      message: 'If we can match an active OXON account, we will contact the account holder to verify the request and complete it within 30 days.',
    });
  } catch (error) {
    next(error);
  }
};
