const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { protect, authorize } = require('../middlewares/auth');
const { guestDeviceLimiter } = require('../middlewares/rateLimits');
const validate = require('../middlewares/validate');
const { notificationValidation } = require('../validations');

// A phone that isn't signed in: no account needed.
router.post('/guest-token', guestDeviceLimiter, validate(notificationValidation.guestToken), notificationController.registerGuestToken);

// User routes deliberately exclude operational Staff accounts.
const customerOrAdmin = [protect, authorize('buyer', 'wholesaler', 'admin')];
router.post('/register-token', ...customerOrAdmin, validate(notificationValidation.deviceToken), notificationController.registerFcmToken);
router.post('/unregister-token', ...customerOrAdmin, validate(notificationValidation.deviceToken), notificationController.unregisterFcmToken);

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
