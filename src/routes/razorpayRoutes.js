const express = require('express');
const router = express.Router();
const razorpayController = require('../controllers/razorpayController');
const { protect } = require('../middlewares/auth');

// Create Razorpay order (requires auth)
router.post('/create-order', protect, razorpayController.createOrder);

// Verify Razorpay payment (requires auth)
router.post('/verify', protect, razorpayController.verifyPayment);

// Get Razorpay key (public - for app initialization)
router.get('/key', razorpayController.getKey);

module.exports = router;
