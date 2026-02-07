const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { protect, authorize } = require('../middlewares/auth');

// User routes - register/unregister FCM tokens
router.post('/register-token', protect, notificationController.registerFcmToken);
router.post('/unregister-token', protect, notificationController.unregisterFcmToken);

// Subscribe/unsubscribe to topics
router.post('/subscribe', protect, notificationController.subscribeToTopic);
router.post('/unsubscribe', protect, notificationController.unsubscribeFromTopic);

// Admin routes - send notifications
router.post('/send-to-user', protect, authorize('admin'), notificationController.sendToUser);
router.post('/send-to-topic', protect, authorize('admin'), notificationController.sendToTopic);
router.post('/send-promotion', protect, authorize('admin'), notificationController.sendPromotion);

module.exports = router;
