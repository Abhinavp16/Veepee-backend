const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { optionalAuth } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { productValidation } = require('../validations');

router.get('/', optionalAuth, validate(productValidation.list, 'query'), productController.getProducts);
router.get('/categories', optionalAuth, productController.getCategories);
router.get('/featured', optionalAuth, productController.getFeaturedProducts);
router.get('/search', optionalAuth, validate(productValidation.search, 'query'), productController.searchProducts);
router.get('/:slug', optionalAuth, productController.getProductBySlug);
router.post('/:id/view', optionalAuth, productController.trackProductView);
router.post('/:id/event', optionalAuth, productController.trackProductEvent);
router.patch('/:id/hindi-name', productController.updateProductNameHindi);

module.exports = router;
