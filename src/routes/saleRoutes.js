const express = require('express');
const { optionalAuth } = require('../middlewares/auth');
const saleController = require('../controllers/saleController');

const router = express.Router();

// Sale pages (Diwali Sale, Stock Clearance, ...) for the app.
router.get('/live', optionalAuth, saleController.getLiveSales);
router.get('/:id', optionalAuth, saleController.getSale);
router.get('/:id/products', optionalAuth, saleController.getSaleProducts);

module.exports = router;
