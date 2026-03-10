const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { getFirebaseApp, getMessaging, getStorage } = require('../config/firebase');

const authRoutes = require('./authRoutes');
const productRoutes = require('./productRoutes');
const cartRoutes = require('./cartRoutes');
const negotiationRoutes = require('./negotiationRoutes');
const orderRoutes = require('./orderRoutes');
const paymentRoutes = require('./paymentRoutes');
const adminRoutes = require('./adminRoutes');
const companyRoutes = require('./companyRoutes');
const categoryRoutes = require('./categoryRoutes');
const uploadRoutes = require('./uploadRoutes');
const notificationRoutes = require('./notificationRoutes');
const razorpayRoutes = require('./razorpayRoutes');

const apiStartTime = new Date();

const getMongoStateName = (readyState) => {
  switch (readyState) {
    case 0:
      return 'disconnected';
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'unknown';
  }
};

const getMongoHealth = async () => {
  const state = getMongoStateName(mongoose.connection.readyState);
  const result = {
    name: 'mongodb',
    configured: Boolean(process.env.MONGODB_URI),
    state,
    host: mongoose.connection.host || null,
    database: mongoose.connection.name || null,
    ok: false,
    details: null,
  };

  if (!result.configured) {
    result.details = 'MONGODB_URI not configured';
    return result;
  }

  if (mongoose.connection.readyState !== 1) {
    result.details = `MongoDB not connected (state: ${state})`;
    return result;
  }

  try {
    const ping = await mongoose.connection.db.admin().command({ ping: 1 });
    result.ok = ping?.ok === 1;
    result.details = result.ok ? 'MongoDB ping successful' : 'MongoDB ping failed';
    return result;
  } catch (error) {
    result.details = error.message;
    return result;
  }
};

const getFirebaseHealth = () => {
  const configured = Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_PRIVATE_KEY &&
    process.env.FIREBASE_CLIENT_EMAIL
  );

  const result = {
    name: 'firebase',
    configured,
    initialized: false,
    messaging: false,
    storage: false,
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    ok: false,
    details: null,
  };

  if (!configured) {
    result.ok = true; // Optional service in this API
    result.details = 'Firebase not configured (optional)';
    return result;
  }

  try {
    const app = getFirebaseApp();
    result.initialized = Boolean(app);
    result.messaging = Boolean(getMessaging());
    result.storage = Boolean(getStorage());
    result.ok = result.initialized && result.messaging && result.storage;
    result.details = result.ok
      ? 'Firebase initialized'
      : 'Firebase configured but initialization is incomplete';
    return result;
  } catch (error) {
    result.details = error.message;
    return result;
  }
};

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'AgriMart API v1',
    version: '1.0.0',
    endpoints: {
      auth: '/api/v1/auth',
      products: '/api/v1/products',
      cart: '/api/v1/cart',
      negotiations: '/api/v1/negotiations',
      orders: '/api/v1/orders',
      payments: '/api/v1/payments',
      admin: '/api/v1/admin',
      companies: '/api/v1/companies',
      categories: '/api/v1/categories',
      upload: '/api/v1/upload',
      notifications: '/api/v1/notifications',
      health: '/api/v1/health',
      healthLive: '/api/v1/health/live',
    },
  });
});

// Lightweight liveness probe
router.get('/health/live', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
});

// Full health check for API dependencies
router.get('/health', async (req, res) => {
  const mongo = await getMongoHealth();
  const firebase = getFirebaseHealth();

  const checks = {
    api: {
      name: 'api',
      ok: true,
      startedAt: apiStartTime.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      env: process.env.NODE_ENV || 'unknown',
      pid: process.pid,
    },
    mongodb: mongo,
    firebase,
    config: {
      jwtConfigured: Boolean(process.env.JWT_SECRET),
      razorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      mongodbUriConfigured: Boolean(process.env.MONGODB_URI),
    },
  };

  // API is considered ready when critical dependencies are healthy.
  // MongoDB is critical; Firebase is optional unless you rely on it for specific flows.
  const overallOk = checks.api.ok && checks.mongodb.ok;

  res.status(overallOk ? 200 : 503).json({
    success: overallOk,
    status: overallOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
    memory: process.memoryUsage(),
  });
});

// Public endpoint for hero banners, promo banners & whatsapp (no auth required)
router.get('/settings/banners', async (req, res, next) => {
  try {
    const { Settings } = require('../models');
    const settings = await Settings.getSettings();
    const heroBanners = (settings.heroBanners || [])
      .filter(b => b.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const promoBanners = (settings.promoBanners || [])
      .filter(b => b.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const whatsapp = settings.socialLinks?.whatsapp || settings.businessPhone || '';
    res.json({ success: true, data: { heroBanners, promoBanners, whatsapp } });
  } catch (error) {
    next(error);
  }
});

// Public endpoint for website products page content
router.get('/settings/website-content', async (req, res, next) => {
  try {
    const { WebsiteSettings } = require('../models');
    const settings = await WebsiteSettings.getSettings();

    const productCategories = (settings.productCategories || [])
      .filter((item) => item.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const featuredProducts = (settings.featuredProducts || [])
      .filter((item) => item.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const heroCards = (settings.heroCards || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const categoriesSection = settings.categoriesSection || {};
    const featuredSection = settings.featuredSection || {};

    res.json({
      success: true,
      data: {
        productCategories,
        featuredProducts,
        heroCards,
        categoriesSection,
        featuredSection,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/negotiations', negotiationRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/admin', adminRoutes);
router.use('/companies', companyRoutes);
router.use('/categories', categoryRoutes);
router.use('/upload', uploadRoutes);
router.use('/notifications', notificationRoutes);
router.use('/razorpay', razorpayRoutes);

// Public endpoint for active offers (no auth required)
router.get('/offers', async (req, res, next) => {
  try {
    const { Offer } = require('../models');
    const { targetGroup } = req.query;

    const query = { isActive: true };
    if (targetGroup) {
      query.targetGroup = { $in: [targetGroup, 'all'] };
    }

    const offers = await Offer.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: offers });
  } catch (error) {
    next(error);
  }
});

// Public endpoint for active reviews (no auth required)
router.get('/reviews', async (req, res, next) => {
  try {
    const { Review } = require('../models');
    const reviews = await Review.find({ isActive: true }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: reviews });
  } catch (error) {
    next(error);
  }
});

// Public endpoint for payment options (no auth required)
router.get('/settings/payment-options', async (req, res, next) => {
  try {
    const { Settings } = require('../models');
    const settings = await Settings.getSettings();

    // Razorpay is enabled if env vars are set OR DB setting is true
    const hasEnvRazorpay = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    const razorpayEnabled = hasEnvRazorpay || settings.razorpayEnabled || false;
    const razorpayKeyId = process.env.RAZORPAY_KEY_ID || settings.razorpayKeyId || '';

    res.json({
      success: true,
      data: {
        razorpayEnabled,
        razorpayKeyId: razorpayEnabled ? razorpayKeyId : null,
        bankTransferEnabled: settings.bankTransferEnabled !== false,
        bankDetails: settings.bankTransferEnabled !== false ? {
          bankName: settings.bankName || '',
          accountNumber: settings.bankAccountNumber || '',
          ifscCode: settings.bankIfscCode || '',
          accountHolderName: settings.bankAccountHolderName || '',
        } : null,
        upiId: settings.upiId || '',
        upiDisplayName: settings.upiDisplayName || '',
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
