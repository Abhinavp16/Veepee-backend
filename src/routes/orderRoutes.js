const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { protect } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { orderValidation } = require('../validations');

router.use(protect);

router.get('/', orderController.getMyOrders);
router.post('/', validate(orderValidation.createFromCart), orderController.createOrderFromCart);
router.post('/from-negotiation', validate(orderValidation.createFromNegotiation), orderController.createOrderFromNegotiation);
router.get('/:id', orderController.getOrderById);

module.exports = router;
