const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { getFirebaseApp, getMessaging, getStorage } = require('../config/firebase');
const connectDB = require('../config/database');
const { getDatabaseHealth } = require('../config/database');
const { PRODUCT_STATUS } = require('../utils/constants');
const cronAuth = require('../middlewares/cronAuth');
const { publicFormLimiter } = require('../middlewares/rateLimits');
const validate = require('../middlewares/validate');
const { authValidation } = require('../validations');
const accountDeletionController = require('../controllers/accountDeletionController');

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

const normalizeNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const getPrimaryWebsiteProductImage = (product = {}) => {
  const images = Array.isArray(product.images) ? [...product.images] : [];
  images.sort((a, b) => (a?.order || 0) - (b?.order || 0));
  const primary = images.find((image) => image?.isPrimary) || images[0];
  return primary?.url || '';
};

const mapLiveProductToWebsiteProduct = (product, fallback = {}, order = 0) => {
  const images = Array.isArray(product?.images)
    ? product.images
        .map((image) => String(image?.url || '').trim())
        .filter(Boolean)
    : [];
  const image = getPrimaryWebsiteProductImage(product) || String(fallback?.image || '').trim();

  return {
    productId: String(product?._id || fallback?.productId || ''),
    name: String(product?.name || fallback?.name || '').trim(),
    slug: String(product?.slug || fallback?.slug || '').trim(),
    category: String(product?.category || fallback?.category || '').trim(),
    shortDescription: String(product?.shortDescription || fallback?.shortDescription || '').trim(),
    description: String(product?.description || fallback?.description || '').trim(),
    sku: String(product?.sku || fallback?.sku || '').trim(),
    mrp: normalizeNumber(product?.mrp ?? fallback?.mrp),
    retailPrice: normalizeNumber(product?.retailPrice ?? fallback?.retailPrice),
    wholesalePrice: normalizeNumber(product?.wholesalePrice ?? fallback?.wholesalePrice),
    stock: normalizeNumber(product?.stock ?? fallback?.stock),
    status: String(product?.status || fallback?.status || '').trim(),
    image,
    images: images.length > 0 ? images : (image ? [image] : []),
    order,
  };
};

const mapStoredWebsiteProduct = (product = {}, order = 0) => {
  const images = Array.isArray(product?.images)
    ? product.images.map((image) => String(image || '').trim()).filter(Boolean)
    : [];
  const image = String(product?.image || images[0] || '').trim();

  return {
    productId: String(product?.productId || '').trim(),
    name: String(product?.name || '').trim(),
    slug: String(product?.slug || '').trim(),
    category: String(product?.category || '').trim(),
    shortDescription: String(product?.shortDescription || '').trim(),
    description: String(product?.description || '').trim(),
    sku: String(product?.sku || '').trim(),
    mrp: normalizeNumber(product?.mrp),
    retailPrice: normalizeNumber(product?.retailPrice),
    wholesalePrice: normalizeNumber(product?.wholesalePrice),
    stock: normalizeNumber(product?.stock),
    status: String(product?.status || '').trim(),
    image,
    images: images.length > 0 ? images : (image ? [image] : []),
    order,
  };
};


const getMongoHealth = async () => {
  const current = getDatabaseHealth();
  const result = {
    name: 'mongodb',
    configured: Boolean(process.env.MONGODB_URI),
    state: current.state,
    host: current.host,
    database: current.database,
    ok: false,
    details: current.lastError || null,
    lastConnectedAt: current.lastConnectedAt,
    lastDisconnectedAt: current.lastDisconnectedAt,
  };

  if (!result.configured) {
    result.details = 'MONGODB_URI not configured';
    return result;
  }

  if (current.state !== 'connected') {
    try {
      await connectDB();
    } catch (error) {
      const afterFailure = getDatabaseHealth();
      result.state = afterFailure.state;
      result.host = afterFailure.host;
      result.database = afterFailure.database;
      result.lastConnectedAt = afterFailure.lastConnectedAt;
      result.lastDisconnectedAt = afterFailure.lastDisconnectedAt;
      result.details = afterFailure.lastError || error.message;
      return result;
    }
  }

  try {
    const afterConnect = getDatabaseHealth();
    if (afterConnect.state !== 'connected') {
      result.state = afterConnect.state;
      result.host = afterConnect.host;
      result.database = afterConnect.database;
      result.lastConnectedAt = afterConnect.lastConnectedAt;
      result.lastDisconnectedAt = afterConnect.lastDisconnectedAt;
      result.details = afterConnect.lastError || `MongoDB not connected (state: ${afterConnect.state})`;
      return result;
    }

    const mongoose = require('mongoose');
    const ping = await mongoose.connection.db.admin().command({ ping: 1 });
    result.ok = ping?.ok === 1;
    result.state = 'connected';
    result.host = mongoose.connection.host || result.host;
    result.database = mongoose.connection.name || result.database;
    result.details = result.ok ? 'MongoDB ping successful' : 'MongoDB ping failed';
    return result;
  } catch (error) {
    result.details = error.message;
    return result;
  }
};

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'VeepeeImpex API v1',
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
// Public: only whether the API and its database are up. Hosts, process and
// memory details are not shown to the internet.
router.get('/health', async (req, res) => {
  const mongo = await getMongoHealth();
  const ok = Boolean(mongo?.ok);
  res.status(ok ? 200 : 503).json({
    success: ok,
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: { api: { ok: true }, mongodb: { ok } },
  });
});

// Public endpoint for hero banners, promo banners & whatsapp (no auth required)
// Public forced-update rule. Never cached so a flipped switch applies at once.
router.get('/settings/mobile-app', async (req, res, next) => {
  try {
    const { Settings } = require('../models');
    const settings = await Settings.getSettings();
    const pick = (rule = {}) => ({
      enabled: rule.enabled === true,
      latestVersion: rule.latestVersion || '',
      latestBuildNumber: Number(rule.latestBuildNumber) || 0,
      storeUrl: rule.storeUrl || '',
      title: rule.title || '',
      message: rule.message || '',
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        android: pick(settings.mobileApp?.android),
        ios: pick(settings.mobileApp?.ios),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/settings/banners', require('../middlewares/auth').optionalAuth, async (req, res, next) => {
  try {
    const { Settings } = require('../models');
    // Sale banners only while their sale is live, and only for its audience.
    const { withoutUnavailableSaleBanners } = require('../services/saleService');
    const role = req.user?.role === 'wholesaler' ? 'wholesaler' : 'buyer';
    const settings = await Settings.getSettings();
    const heroBanners = await withoutUnavailableSaleBanners((settings.heroBanners || [])
      .filter(b => b.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0)), role);
    const promoBanners = await withoutUnavailableSaleBanners((settings.promoBanners || [])
      .filter(b => b.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0)), role);
    const whatsapp = settings.socialLinks?.whatsapp || settings.businessPhone || '';
    res.json({ success: true, data: { heroBanners, promoBanners, whatsapp } });
  } catch (error) {
    next(error);
  }
});

// Public endpoint for website products page content
router.get('/settings/website-content', async (req, res, next) => {
  try {
    const { Product, WebsiteSettings } = require('../models');
    const settings = await WebsiteSettings.getSettings();

    const rawProductCategories = (settings.productCategories || [])
      .filter((item) => item.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const linkedProductIds = [...new Set(
      rawProductCategories.flatMap((category) => (
        Array.isArray(category?.productDetails)
          ? category.productDetails
              .map((detail) => String(detail?.productId || '').trim())
              .filter((id) => mongoose.Types.ObjectId.isValid(id))
          : []
      ))
    )];

    const linkedProducts = linkedProductIds.length > 0
      ? await Product.find({
          _id: { $in: linkedProductIds },
          status: PRODUCT_STATUS.ACTIVE,
        })
          .select('name slug category shortDescription description sku mrp retailPrice wholesalePrice stock status images')
          .lean()
      : [];
    const linkedProductsById = new Map(linkedProducts.map((product) => [String(product._id), product]));

    const productCategories = rawProductCategories.map((category, categoryIndex) => {
      const baseCategory = typeof category?.toObject === 'function' ? category.toObject() : { ...category };
      const savedDetails = Array.isArray(baseCategory.productDetails) ? baseCategory.productDetails : [];
      const savedNames = Array.isArray(baseCategory.products)
        ? baseCategory.products.map((name) => String(name || '').trim()).filter(Boolean)
        : [];

      const productDetails = savedDetails
        .sort((a, b) => (a?.order || 0) - (b?.order || 0))
        .map((detail, detailIndex) => {
          const productId = String(detail?.productId || '').trim();
          if (productId) {
            const liveProduct = linkedProductsById.get(productId);
            if (!liveProduct) {
              return null;
            }
            return mapLiveProductToWebsiteProduct(liveProduct, detail, detailIndex);
          }

          const storedProduct = mapStoredWebsiteProduct(detail, detailIndex);
          return storedProduct.name ? storedProduct : null;
        })
        .filter(Boolean);

      return {
        ...baseCategory,
        products: productDetails.length > 0
          ? productDetails.map((product) => product.name)
          : savedNames,
        productDetails,
        order: Number.isFinite(baseCategory.order) ? baseCategory.order : categoryIndex,
      };
    });

    const featuredProducts = (settings.featuredProducts || [])
      .filter((item) => item.isActive !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const heroCards = (settings.heroCards || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const labels = (settings.labels || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const categoriesSection = settings.categoriesSection || {};
    const featuredSection = settings.featuredSection || {};

    res.json({
      success: true,
      data: {
        productCategories,
        featuredProducts,
        heroCards,
        labels,
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
router.use('/sales', require('./saleRoutes'));
router.use('/categories', categoryRoutes);
router.use('/upload', uploadRoutes);
router.use('/notifications', notificationRoutes);

// Public endpoint for active offers (no auth required)
router.get('/offers', async (req, res, next) => {
  try {
    const { Offer } = require('../models');
    const { targetGroup } = req.query;

    // Same date rule as checkout: not started yet or already ended means not listed.
    const now = new Date();
    const query = {
      isActive: true,
      startDate: { $lte: now },
      $or: [{ endDate: null }, { endDate: { $exists: false } }, { endDate: { $gte: now } }],
    };
    if (targetGroup) {
      query.targetGroup = { $in: [targetGroup, 'all'] };
    }

    const offers = await Offer.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: offers });
  } catch (error) {
    next(error);
  }
});

// Public account-deletion request form (website). Replies identically whether or not an account matches.
router.post('/account-deletion-request', publicFormLimiter, validate(authValidation.publicAccountDeletionRequest), accountDeletionController.requestDeletionFromWebsite);

// Scheduled job: apply scheduled price changes that have come due (Vercel Cron).
router.get('/internal/cron/price-changes', cronAuth, async (req, res, next) => {
  try {
    const { processDuePriceChanges } = require('../services/priceLifecycleService');
    const result = await processDuePriceChanges();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Scheduled job: everything that runs once a day (Vercel Cron).
router.get('/internal/cron/daily', cronAuth, async (req, res, next) => {
  try {
    const { runDailyJobs } = require('../services/dailyJobs');
    res.json({ success: true, data: await runDailyJobs() });
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

    res.json({
      success: true,
      data: {
        // Online gateway payments are off: customers pay by bank transfer or
        // UPI and upload a screenshot. (Kept for older app versions.)
        razorpayEnabled: false,
        razorpayKeyId: null,
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
