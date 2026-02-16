const Razorpay = require('razorpay');
const crypto = require('crypto');
const { Order, Payment, Settings } = require('../models');

// Get Razorpay credentials - env vars take priority, then DB settings
const getRazorpayCredentials = async () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  
  if (keyId && keySecret) {
    return { keyId, keySecret };
  }
  
  const settings = await Settings.getSettings();
  if (settings.razorpayKeyId && settings.razorpayKeySecret) {
    return { keyId: settings.razorpayKeyId, keySecret: settings.razorpayKeySecret };
  }
  
  throw new Error('Razorpay credentials not configured');
};

const getRazorpayInstance = async () => {
  const { keyId, keySecret } = await getRazorpayCredentials();
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

// Create Razorpay order
exports.createOrder = async (req, res, next) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required' });
    }

    // Fetch the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Check if order belongs to user
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Check if already paid
    if (order.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'Order already paid' });
    }

    const razorpay = await getRazorpayInstance();
    const { keyId } = await getRazorpayCredentials();

    // Amount in paise (INR smallest unit)
    const amountInPaise = Math.round(order.total * 100);

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: order.orderNumber,
      notes: {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        userId: req.user._id.toString(),
      },
    });

    // Update or create payment record with Razorpay order ID
    await Payment.findOneAndUpdate(
      { orderId: order._id },
      {
        orderId: order._id,
        userId: req.user._id,
        amount: order.total,
        method: 'razorpay',
        razorpayOrderId: razorpayOrder.id,
        status: 'pending',
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      data: {
        razorpayOrderId: razorpayOrder.id,
        razorpayKeyId: keyId,
        amount: amountInPaise,
        currency: 'INR',
        orderNumber: order.orderNumber,
        prefill: {
          name: req.user.name,
          email: req.user.email,
          contact: req.user.phone || '',
        },
      },
    });
  } catch (error) {
    console.error('Razorpay create order error:', error);
    next(error);
  }
};

// Verify Razorpay payment
exports.verifyPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      return res.status(400).json({ success: false, message: 'Missing payment verification data' });
    }

    let credentials;
    try {
      credentials = await getRazorpayCredentials();
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Razorpay not configured' });
    }

    // Verify signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', credentials.keySecret)
      .update(body.toString())
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

    // Update payment record
    const payment = await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      {
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        status: 'verified',
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    // Update order status to payment_verified
    const orderDoc = await Order.findById(orderId);
    if (orderDoc) {
      orderDoc.addStatusHistory('payment_verified', 'Payment verified via Razorpay', null);
      await orderDoc.save();
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      data: {
        paymentId: razorpay_payment_id,
        orderId,
      },
    });
  } catch (error) {
    console.error('Razorpay verify payment error:', error);
    next(error);
  }
};

// Get Razorpay key (public endpoint for app)
exports.getKey = async (req, res, next) => {
  try {
    const { keyId } = await getRazorpayCredentials();

    res.json({
      success: true,
      data: { keyId },
    });
  } catch (error) {
    res.status(404).json({ success: false, message: 'Razorpay not configured' });
  }
};
