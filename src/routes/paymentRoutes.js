const express = require('express');
const router = express.Router();
const multer = require('multer');
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middlewares/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG/PNG images are allowed'), false);
    }
  },
});

router.get('/upi-details', paymentController.getUpiDetails);

router.use(protect);

router.post(
  '/:orderId/upload',
  upload.single('screenshot'),
  paymentController.uploadScreenshot
);
router.get('/:orderId', paymentController.getPaymentStatus);

module.exports = router;
