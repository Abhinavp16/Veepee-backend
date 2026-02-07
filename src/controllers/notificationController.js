const notificationService = require('../services/notificationService');
const { User } = require('../models');

exports.registerFcmToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user.id;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required',
      });
    }

    // Add token to user's fcmTokens array (avoid duplicates)
    await User.findByIdAndUpdate(
      userId,
      { $addToSet: { fcmTokens: fcmToken } },
      { new: true }
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
    const userId = req.user.id;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required',
      });
    }

    // Remove token from user's fcmTokens array
    await User.findByIdAndUpdate(
      userId,
      { $pull: { fcmTokens: fcmToken } },
      { new: true }
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
    const userId = req.user.id;

    if (!topic) {
      return res.status(400).json({
        success: false,
        message: 'Topic is required',
      });
    }

    const user = await User.findById(userId).select('fcmTokens');
    if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No FCM tokens registered for this user',
      });
    }

    await notificationService.subscribeToTopic(user.fcmTokens, topic);

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
    const userId = req.user.id;

    if (!topic) {
      return res.status(400).json({
        success: false,
        message: 'Topic is required',
      });
    }

    const user = await User.findById(userId).select('fcmTokens');
    if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No FCM tokens registered for this user',
      });
    }

    await notificationService.unsubscribeFromTopic(user.fcmTokens, topic);

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
