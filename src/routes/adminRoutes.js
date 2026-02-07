const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { uploadProductImages } = require('../config/cloudinary');

const adminProductController = require('../controllers/admin/productController');

// Middleware that conditionally applies multer only for multipart/form-data requests
const optionalUpload = (multerMiddleware) => {
  return (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      return multerMiddleware(req, res, next);
    }
    next();
  };
};
const adminNegotiationController = require('../controllers/admin/negotiationController');
const adminOrderController = require('../controllers/admin/orderController');
const adminPaymentController = require('../controllers/admin/paymentController');
const adminAnalyticsController = require('../controllers/admin/analyticsController');
const adminSettingsController = require('../controllers/admin/settingsController');
const adminCustomerController = require('../controllers/admin/customerController');

const { adminValidation } = require('../validations');

router.use(protect);
router.use(adminOnly);

// Products
router.get('/products', adminProductController.getProducts);
router.post(
  '/products',
  optionalUpload(uploadProductImages.array('images', 10)),
  validate(adminValidation.createProduct),
  adminProductController.createProduct
);
router.get('/products/:id', adminProductController.getProductById);
router.put(
  '/products/:id',
  optionalUpload(uploadProductImages.array('images', 10)),
  validate(adminValidation.updateProduct),
  adminProductController.updateProduct
);
router.delete('/products/:id', adminProductController.deleteProduct);
router.put('/products/:id/stock', validate(adminValidation.updateStock), adminProductController.updateStock);
router.delete('/products/:id/images/:imageId', adminProductController.deleteProductImage);

// Negotiations
router.get('/negotiations', adminNegotiationController.getNegotiations);
router.get('/negotiations/:id', adminNegotiationController.getNegotiationById);
router.put('/negotiations/:id/accept', adminNegotiationController.acceptNegotiation);
router.put('/negotiations/:id/reject', validate(adminValidation.rejectNegotiation), adminNegotiationController.rejectNegotiation);
router.put('/negotiations/:id/counter', validate(adminValidation.counterNegotiation), adminNegotiationController.counterNegotiation);

// Orders
router.get('/orders', adminOrderController.getOrders);
router.get('/orders/:id', adminOrderController.getOrderById);
router.put('/orders/:id/status', validate(adminValidation.updateOrderStatus), adminOrderController.updateOrderStatus);
router.put('/orders/:id/ship', validate(adminValidation.shipOrder), adminOrderController.shipOrder);

// Payments
router.get('/payments', adminPaymentController.getPayments);
router.put('/payments/:id/verify', adminPaymentController.verifyPayment);
router.put('/payments/:id/reject', validate(adminValidation.rejectPayment), adminPaymentController.rejectPayment);

// Customers
router.get('/customers', adminCustomerController.getCustomers);
router.get('/customers/:id', adminCustomerController.getCustomerById);

// Analytics
router.get('/analytics/dashboard', adminAnalyticsController.getDashboardStats);
router.get('/analytics/products', adminAnalyticsController.getProductAnalytics);
router.get('/analytics/sales', adminAnalyticsController.getSalesAnalytics);
router.get('/analytics/demand', adminAnalyticsController.getDemandInsights);

// Settings
router.get('/settings', adminSettingsController.getSettings);
router.put('/settings', validate(adminValidation.updateSettings), adminSettingsController.updateSettings);

module.exports = router;
