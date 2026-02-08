const notificationService = require('../services/notificationService');
const { DeviceToken, Notification } = require('../models');

exports.registerFcmToken = async (req, res, next) => {
  try {
    const { fcmToken, platform } = req.body;
    const userId = req.user._id;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required',
      });
    }

    // Upsert: create or reactivate the token
    await DeviceToken.findOneAndUpdate(
      { userId, fcmToken },
      { $set: { isActive: true, platform: platform || 'android' } },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      message: 'FCM token registered successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.unregisterFcmToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user._id;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required',
      });
    }

    // Deactivate the token
    await DeviceToken.findOneAndUpdate(
      { userId, fcmToken },
      { $set: { isActive: false } }
    );

    res.json({
      success: true,
      message: 'FCM token unregistered successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.subscribeToTopic = async (req, res, next) => {
  try {
    const { topic } = req.body;
    const userId = req.user._id;

    if (!topic) {
      return res.status(400).json({
        success: false,
        message: 'Topic is required',
      });
    }

    const tokens = await DeviceToken.find({ userId, isActive: true }).select('fcmToken');
    if (!tokens || tokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No FCM tokens registered for this user',
      });
    }

    await notificationService.subscribeToTopic(tokens.map(t => t.fcmToken), topic);

    res.json({
      success: true,
      message: `Subscribed to topic: ${topic}`,
    });
  } catch (error) {
    next(error);
  }
};

exports.unsubscribeFromTopic = async (req, res, next) => {
  try {
    const { topic } = req.body;
    const userId = req.user._id;

    if (!topic) {
      return res.status(400).json({
        success: false,
        message: 'Topic is required',
      });
    }

    const tokens = await DeviceToken.find({ userId, isActive: true }).select('fcmToken');
    if (!tokens || tokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No FCM tokens registered for this user',
      });
    }

    await notificationService.unsubscribeFromTopic(tokens.map(t => t.fcmToken), topic);

    res.json({
      success: true,
      message: `Unsubscribed from topic: ${topic}`,
    });
  } catch (error) {
    next(error);
  }
};

// Admin: Send notification to specific user
exports.sendToUser = async (req, res, next) => {
  try {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({
        success: false,
        message: 'userId, title, and body are required',
      });
    }

    const result = await notificationService.sendToUser(
      userId,
      { title, body },
      data || {}
    );

    res.json({
      success: true,
      message: 'Notification sent',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// Admin: Send notification to topic
exports.sendToTopic = async (req, res, next) => {
  try {
    const { topic, title, body, imageUrl, data } = req.body;

    if (!topic || !title || !body) {
      return res.status(400).json({
        success: false,
        message: 'topic, title, and body are required',
      });
    }

    const result = await notificationService.sendToTopic(
      topic,
      { title, body, imageUrl },
      data || {}
    );

    res.json({
      success: true,
      message: 'Notification sent to topic',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// Admin: Send promotional notification
exports.sendPromotion = async (req, res, next) => {
  try {
    const { title, body, imageUrl } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: 'title and body are required',
      });
    }

    const result = await notificationService.sendPromotionalNotification(
      title,
      body,
      imageUrl
    );

    res.json({
      success: true,
      message: 'Promotional notification sent',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// Get user's notifications
exports.getMyNotifications = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Notification.countDocuments({ userId }),
      Notification.countDocuments({ userId, isRead: false }),
    ]);

    res.json({
      success: true,
      data: notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Mark notifications as read
exports.markAsRead = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { ids } = req.body; // array of notification IDs, or empty to mark all

    const filter = { userId };
    if (ids && ids.length > 0) {
      filter._id = { $in: ids };
    }

    await Notification.updateMany(filter, { $set: { isRead: true } });

    res.json({ success: true, message: 'Notifications marked as read' });
  } catch (error) {
    next(error);
  }
};
