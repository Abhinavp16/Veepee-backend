const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');
const { protect, authorize } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { cartValidation } = require('../validations');

router.use(protect);
router.use(authorize('buyer', 'wholesaler', 'admin'));

router.get('/', cartController.getCart);
router.post('/validate', cartController.validateCart);
router.post('/items', validate(cartValidation.addItem), cartController.addItem);
router.put('/items/:productId', validate(cartValidation.updateItem), cartController.updateItemQuantity);
router.delete('/items/:productId', cartController.removeItem);
router.delete('/', cartController.clearCart);

module.exports = router;
