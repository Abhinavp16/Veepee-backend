const express = require('express');
const router = express.Router();
const negotiationController = require('../controllers/negotiationController');
const { protect, authorize } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { negotiationValidation } = require('../validations');

router.use(protect);
router.use(authorize('buyer', 'wholesaler', 'admin'));

router.get('/', negotiationController.getMyNegotiations);
// Requirements: several products negotiated and paid for together.
router.post('/from-cart', authorize('wholesaler'), validate(negotiationValidation.fromCart), negotiationController.createFromCart);
router.get('/groups/:groupId', negotiationController.getGroup);
router.post('/groups/:groupId/accept', negotiationController.respondToGroup('accept'));
router.post('/groups/:groupId/reject', negotiationController.respondToGroup('reject'));
router.post('/', validate(negotiationValidation.create), negotiationController.createNegotiation);
router.get('/:id', negotiationController.getNegotiationById);
router.post('/:id/counter', validate(negotiationValidation.counter), negotiationController.counterOffer);
router.post('/:id/accept', negotiationController.acceptOffer);
router.post('/:id/reject', negotiationController.rejectNegotiation);

module.exports = router;
