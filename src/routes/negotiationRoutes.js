const express = require('express');
const router = express.Router();
const negotiationController = require('../controllers/negotiationController');
const { protect, authorize } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { negotiationValidation } = require('../validations');

router.use(protect);

router.get('/', negotiationController.getMyNegotiations);
router.post('/', validate(negotiationValidation.create), negotiationController.createNegotiation);
router.get('/:id', negotiationController.getNegotiationById);
router.post('/:id/counter', validate(negotiationValidation.counter), negotiationController.counterOffer);
router.post('/:id/accept', negotiationController.acceptOffer);
router.post('/:id/reject', negotiationController.rejectNegotiation);

module.exports = router;
