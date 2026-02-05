const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { optionalAuth } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { productValidation } = require('../validations');

router.get('/', validate(productValidation.list, 'query'), productController.getProducts);
router.get('/categories', productController.getCategories);
router.get('/featured', productController.getFeaturedProducts);
router.get('/search', validate(productValidation.search, 'query'), productController.searchProducts);
router.get('/:slug', productController.getProductBySlug);
router.post('/:id/view', optionalAuth, productController.trackProductView);

module.exports = router;
