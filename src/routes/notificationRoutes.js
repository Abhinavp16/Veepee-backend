const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { protect, authorize } = require('../middlewares/auth');

// User routes deliberately exclude operational Staff accounts.
const customerOrAdmin = [protect, authorize('buyer', 'wholesaler', 'admin')];
router.post('/register-token', ...customerOrAdmin, notificationController.registerFcmToken);
router.post('/unregister-token', ...customerOrAdmin, notificationController.unregisterFcmToken);

// Subscribe/unsubscribe to topics
router.post('/subscribe', ...customerOrAdmin, notificationController.subscribeToTopic);
router.post('/unsubscribe', ...customerOrAdmin, notificationController.unsubscribeFromTopic);

// User routes - get & manage notifications
router.get('/my', ...customerOrAdmin, notificationController.getMyNotifications);
router.post('/mark-read', ...customerOrAdmin, notificationController.markAsRead);

// Admin routes - send notifications
router.post('/send-to-user', protect, authorize('admin'), notificationController.sendToUser);
router.post('/send-to-topic', protect, authorize('admin'), notificationController.sendToTopic);
router.post('/send-promotion', protect, authorize('admin'), notificationController.sendPromotion);

module.exports = router;
