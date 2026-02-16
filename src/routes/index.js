const express = require('express');
const router = express.Router();

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
    },
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

module.exports = router;
