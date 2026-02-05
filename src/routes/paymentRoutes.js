const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middlewares/auth');
const { uploadPaymentScreenshot } = require('../config/cloudinary');

router.get('/upi-details', paymentController.getUpiDetails);

router.use(protect);

router.post(
  '/:orderId/upload',
  uploadPaymentScreenshot.single('screenshot'),
  paymentController.uploadScreenshot
);
router.get('/:orderId', paymentController.getPaymentStatus);

module.exports = router;
