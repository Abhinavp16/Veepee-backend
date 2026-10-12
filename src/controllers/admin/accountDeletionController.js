const { AccountDeletionRequest } = require('../../models');
const { BadRequestError, NotFoundError } = require('../../utils/errors');
const { ACTIVE_STATUSES, completeRequest, openOrderCounts } = require('../../services/accountDeletionService');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

exports.getRequests = async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const query = {};
    if (req.query.status) query.status = req.query.status;

    const [requests, total, pendingCount, overdueCount] = await Promise.all([
      AccountDeletionRequest.find(query)
        .populate('userId', 'name email phone role isActive')
        .populate('processedBy', 'name email')
        .sort({ dueAt: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AccountDeletionRequest.countDocuments(query),
      AccountDeletionRequest.countDocuments({ status: { $in: ACTIVE_STATUSES } }),
      AccountDeletionRequest.countDocuments({ status: { $in: ACTIVE_STATUSES }, dueAt: { $lte: new Date() } }),
    ]);

    const counts = await openOrderCounts(requests.map((request) => request.userId?._id).filter(Boolean));
    const data = requests.map((request) => ({
      ...request,
      openOrderCount: counts.get(String(request.userId?._id)) || 0,
    }));

    res.json({
      success: true,
      ...formatPaginationResponse(data, total, page, limit),
      summary: { open: pendingCount, overdue: overdueCount },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateRequestStatus = async (req, res, next) => {
  try {
    const { status, staffNote, identityVerified } = req.body;
    if (!['in_review', 'rejected'].includes(status)) {
      throw new BadRequestError('Only in-review or rejected status can be set here', 'INVALID_DELETION_STATUS');
    }

    const request = await AccountDeletionRequest.findById(req.params.id);
    if (!request) {
      throw new NotFoundError('Deletion request not found', 'DELETION_REQUEST_NOT_FOUND');
    }
    if (!ACTIVE_STATUSES.includes(request.status)) {
      throw new BadRequestError('This deletion request is no longer actionable', 'DELETION_REQUEST_NOT_ACTIONABLE');
    }

    if (request.source === 'website' && status === 'in_review') {
      if (identityVerified !== true) {
        throw new BadRequestError(
          'Confirm that the website request was verified with the account holder before starting review',
          'DELETION_REQUEST_VERIFICATION_REQUIRED'
        );
      }
      request.identityVerification = {
        verifiedAt: new Date(),
        verifiedBy: req.user._id,
        method: 'staff-confirmed',
      };
    }

    request.status = status;
    request.processedBy = req.user._id;
    request.staffNote = staffNote || null;
    request.events.push({
      action: status,
      byUserId: req.user._id,
      note: staffNote || null,
    });
    await request.save();

    res.json({
      success: true,
      message: status === 'in_review' ? 'Deletion request is now under review.' : 'Deletion request rejected.',
      data: request,
    });
  } catch (error) {
    next(error);
  }
};

exports.completeRequest = async (req, res, next) => {
  try {
    const request = await completeRequest({
      requestId: req.params.id,
      adminUserId: req.user._id,
      staffNote: req.body.staffNote,
      identityVerified: req.body.identityVerified === true,
    });

    res.json({
      success: true,
      message: 'Account access was revoked and the deletion request was completed.',
      data: request,
    });
  } catch (error) {
    next(error);
  }
};
