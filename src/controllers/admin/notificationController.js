const { AdminNotification, DeviceToken } = require('../../models');
const { audiencesFor } = require('../../services/adminNotificationService');
const { paginate, formatPaginationResponse } = require('../../utils/helpers');

const visibleTo = (user) => ({ audience: { $in: audiencesFor(user.role) } });

exports.listNotifications = async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);
    const query = visibleTo(req.user);

    const [rows, total, unreadCount] = await Promise.all([
      AdminNotification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdminNotification.countDocuments(query),
      AdminNotification.countDocuments({ ...query, readBy: { $ne: req.user._id } }),
    ]);

    const data = rows.map(({ readBy, ...row }) => ({
      ...row,
      isRead: readBy.some((id) => String(id) === String(req.user._id)),
    }));
    res.json({ success: true, unreadCount, ...formatPaginationResponse(data, total, page, limit) });
  } catch (error) {
    next(error);
  }
};

// Marks the given notifications (or all visible ones) as read for this person.
exports.markRead = async (req, res, next) => {
  try {
    const { ids } = req.body;
    const filter = { ...visibleTo(req.user), ...(ids?.length ? { _id: { $in: ids } } : {}) };
    await AdminNotification.updateMany(filter, { $addToSet: { readBy: req.user._id } });
    const unreadCount = await AdminNotification.countDocuments({
      ...visibleTo(req.user),
      readBy: { $ne: req.user._id },
    });
    res.json({ success: true, unreadCount });
  } catch (error) {
    next(error);
  }
};

// Browser push token for the signed-in admin or staff member.
exports.registerWebToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    await DeviceToken.updateMany({ fcmToken, userId: { $ne: req.user._id } }, { $set: { isActive: false } });
    await DeviceToken.findOneAndUpdate(
      { userId: req.user._id, fcmToken },
      { $set: { isActive: true, platform: 'web' } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Browser notifications enabled' });
  } catch (error) {
    next(error);
  }
};

exports.unregisterWebToken = async (req, res, next) => {
  try {
    await DeviceToken.updateMany(
      { userId: req.user._id, fcmToken: req.body.fcmToken },
      { $set: { isActive: false } }
    );
    res.json({ success: true, message: 'Browser notifications disabled' });
  } catch (error) {
    next(error);
  }
};
