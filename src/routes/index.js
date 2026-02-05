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
    },
  });
});

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/negotiations', negotiationRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/admin', adminRoutes);
router.use('/companies', companyRoutes);

module.exports = router;
