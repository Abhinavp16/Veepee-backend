const { PasswordResetRequest } = require('../../models');
const { openFilter, openSince, toListItem } = require('../../services/passwordResetRequestService');

const STATUS_FILTERS = {
  open: () => openFilter(),
  expired: () => ({ status: 'pending', lastRequestedAt: { $lte: openSince() } }),
  completed: () => ({ status: 'completed' }),
  // Everything that is over: reset, or lapsed without one.
  history: () => ({ $or: [{ status: 'completed' }, { status: 'pending', lastRequestedAt: { $lte: openSince() } }] }),
  all: () => ({}),
};

/**
 * GET /admin/password-reset-requests?status=open|history|completed|expired|all
 * — customers' "forgot password" requests from the app, newest first, with
 * how many are open.
 */
exports.getRequests = async (req, res, next) => {
  try {
    const filter = (STATUS_FILTERS[req.query.status] || STATUS_FILTERS.open)();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const [requests, open] = await Promise.all([
      PasswordResetRequest.find(filter)
        .sort({ lastRequestedAt: -1 })
        .limit(limit)
        .populate('userId', 'name phone role deletedAt')
        .lean(),
      PasswordResetRequest.countDocuments(openFilter()),
    ]);

    res.json({ success: true, data: requests.map(toListItem), summary: { open } });
  } catch (error) {
    next(error);
  }
};
