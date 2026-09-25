const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { uploadProductImages } = require('../config/cloudinary');

const adminProductController = require('../controllers/admin/productController');
const priceManagementController = require('../controllers/admin/priceManagementController');
const adminNegotiationController = require('../controllers/admin/negotiationController');
const adminOrderController = require('../controllers/admin/orderController');
const adminPaymentController = require('../controllers/admin/paymentController');
const adminAnalyticsController = require('../controllers/admin/analyticsController');
const adminSettingsController = require('../controllers/admin/settingsController');
const websiteSettingsController = require('../controllers/admin/websiteSettingsController');
const adminCustomerController = require('../controllers/admin/customerController');
const adminOfferController = require('../controllers/admin/offerController');
const adminAffiliateController = require('../controllers/admin/affiliateCodeController');
const adminReviewController = require('../controllers/admin/reviewController');
const staffController = require('../controllers/admin/staffController');
const { adminValidation } = require('../validations');

const optionalUpload = (multerMiddleware) => (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) return multerMiddleware(req, res, next);
  return next();
};

const administrator = authorize('admin');
const operationsStaff = authorize('admin', 'staff');

router.use(protect);

// Staff provisioning is intentionally isolated to Administrators. Staff may not
// enumerate, create, change, deactivate, or otherwise manage staff accounts.
router.post('/staff', administrator, validate(adminValidation.createStaff), staffController.createStaff);
router.get('/staff', administrator, validate(adminValidation.staffList, 'query'), staffController.getStaff);
router.patch('/staff/:id', administrator, validate(adminValidation.updateStaff), staffController.updateStaff);

// Price management changes commercial terms and remains Administrator-only.
// The static snapshot route must precede /products/:id so it is never parsed as an id.
router.get('/products/price-snapshot.xlsx', administrator, priceManagementController.exportPriceSnapshot);
router.put('/products/:id/price-change', administrator, validate(adminValidation.priceChange), priceManagementController.createPriceChange);
router.get('/price-change-history', administrator, priceManagementController.getPriceChangeHistory);
router.get('/price-management/config', administrator, priceManagementController.getPriceManagementConfig);
router.get('/price-management/categories', administrator, priceManagementController.getCategories);

// Catalogue reads are the only product capability granted to Staff.
router.get('/products', operationsStaff, adminProductController.getProducts);
router.get('/products/:id', operationsStaff, adminProductController.getProductById);
router.post(
  '/products',
  administrator,
  optionalUpload(uploadProductImages.array('images', 10)),
  validate(adminValidation.createProduct),
  adminProductController.createProduct
);
router.put(
  '/products/:id',
  administrator,
  optionalUpload(uploadProductImages.array('images', 10)),
  validate(adminValidation.updateProduct),
  adminProductController.updateProduct
);
router.put('/products/:id/stock', administrator, validate(adminValidation.updateStock), adminProductController.updateStock);
router.delete('/products/:id', administrator, adminProductController.deleteProduct);
router.get('/products/:id/stock-logs', administrator, adminProductController.getStockLogs);
router.delete('/products/:id/images/:imageId', administrator, adminProductController.deleteProductImage);
router.post('/products/hindi-names/generate-missing', administrator, adminProductController.generateMissingHindiNames);

// Staff may read and respond to negotiations, but has no access to pricing, payments, or marketing.
router.get('/negotiations', operationsStaff, adminNegotiationController.getNegotiations);
router.get('/negotiations/:id', operationsStaff, adminNegotiationController.getNegotiationById);
router.put('/negotiations/:id/accept', operationsStaff, adminNegotiationController.acceptNegotiation);
router.put('/negotiations/:id/reject', operationsStaff, validate(adminValidation.rejectNegotiation), adminNegotiationController.rejectNegotiation);
router.put('/negotiations/:id/counter', operationsStaff, validate(adminValidation.counterNegotiation), adminNegotiationController.counterNegotiation);

// Staff can fulfil orders, but payment verification remains Administrator-only.
router.get('/orders', operationsStaff, adminOrderController.getOrders);
router.get('/orders/:id', operationsStaff, adminOrderController.getOrderById);
router.put('/orders/:id/status', operationsStaff, validate(adminValidation.updateOrderStatus), adminOrderController.updateOrderStatus);
router.put('/orders/:id/ship', operationsStaff, validate(adminValidation.shipOrder), adminOrderController.shipOrder);
router.get('/payments', administrator, adminPaymentController.getPayments);
router.put('/payments/:id/verify', administrator, adminPaymentController.verifyPayment);
router.put('/payments/:id/reject', administrator, validate(adminValidation.rejectPayment), adminPaymentController.rejectPayment);

// Staff may only read customer records; account changes and notifications are Administrator-only.
router.get('/customers', operationsStaff, adminCustomerController.getCustomers);
router.get('/customers/:id', operationsStaff, adminCustomerController.getCustomerById);
router.put('/customers/:id/upgrade', administrator, validate(adminValidation.upgradeCustomer), adminCustomerController.upgradeCustomer);
router.post('/customers/notifications', administrator, validate(adminValidation.sendNotification), adminCustomerController.sendNotification);

// The summary is sufficient for operational context; all other analytics remain Administrator-only.
router.get('/analytics/dashboard', operationsStaff, adminAnalyticsController.getDashboardStats);
router.get('/analytics/products', administrator, adminAnalyticsController.getProductAnalytics);
router.get('/analytics/sales', administrator, adminAnalyticsController.getSalesAnalytics);
router.get('/analytics/demand', administrator, adminAnalyticsController.getDemandInsights);
router.get('/analytics/potential-customers', administrator, adminAnalyticsController.getPotentialCustomers);

router.get('/settings', administrator, adminSettingsController.getSettings);
router.put('/settings', administrator, validate(adminValidation.updateSettings), adminSettingsController.updateSettings);
router.get('/website-settings', administrator, websiteSettingsController.getWebsiteSettings);
router.put('/website-settings', administrator, validate(adminValidation.updateWebsiteSettings), websiteSettingsController.updateWebsiteSettings);

router.get('/offers', administrator, adminOfferController.getOffers);
router.post('/offers', administrator, validate(adminValidation.createOffer), adminOfferController.createOffer);
router.get('/offers/:id', administrator, adminOfferController.getOfferById);
router.put('/offers/:id', administrator, validate(adminValidation.updateOffer), adminOfferController.updateOffer);
router.delete('/offers/:id', administrator, adminOfferController.deleteOffer);
router.patch('/offers/:id/toggle', administrator, adminOfferController.toggleOfferStatus);

router.get('/affiliate-codes', administrator, adminAffiliateController.getAffiliateCodes);
router.post('/affiliate-codes', administrator, validate(adminValidation.createAffiliateCode), adminAffiliateController.createAffiliateCode);
router.get('/affiliate-codes/:id', administrator, adminAffiliateController.getAffiliateCodeById);
router.put('/affiliate-codes/:id', administrator, validate(adminValidation.updateAffiliateCode), adminAffiliateController.updateAffiliateCode);
router.delete('/affiliate-codes/:id', administrator, adminAffiliateController.deleteAffiliateCode);
router.patch('/affiliate-codes/:id/toggle', administrator, adminAffiliateController.toggleAffiliateCodeStatus);
router.get('/affiliate-codes/:id/usage', administrator, adminAffiliateController.getAffiliateCodeUsage);
router.get('/affiliate-codes/:id/commissions', administrator, adminAffiliateController.getAffiliateCodeCommissions);
router.get('/affiliate-commissions', administrator, adminAffiliateController.getAffiliateCommissions);

router.get('/reviews', administrator, adminReviewController.getAllReviews);
router.post('/reviews', administrator, adminReviewController.createReview);
router.get('/reviews/:id', administrator, adminReviewController.getReview);
router.put('/reviews/:id', administrator, adminReviewController.updateReview);
router.delete('/reviews/:id', administrator, adminReviewController.deleteReview);

module.exports = router;
