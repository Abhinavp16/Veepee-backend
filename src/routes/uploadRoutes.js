const express = require('express');
const router = express.Router();
const multer = require('multer');
const uploadController = require('../controllers/uploadController');
const { protect, authorize } = require('../middlewares/auth');
const { ForbiddenError } = require('../utils/errors');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(allowedTypes.includes(file.mimetype) ? null : new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'), allowedTypes.includes(file.mimetype));
  },
});

// Staff may attach assets only while maintaining brands or categories. Product and
// arbitrary asset uploads remain Administrator-only.
const brandOrCategoryUpload = (req, res, next) => {
  if (req.user.role === 'staff' && !['brands', 'categories'].includes(req.query.folder)) {
    return next(new ForbiddenError('Staff can upload brand and category images only', 'INSUFFICIENT_PERMISSIONS'));
  }
  next();
};

router.post('/image', protect, authorize('admin', 'staff'), brandOrCategoryUpload, upload.single('image'), uploadController.uploadImage);
router.post('/images', protect, authorize('admin'), upload.array('images', 10), uploadController.uploadMultipleImages);
router.delete('/image', protect, authorize('admin'), uploadController.deleteImage);

module.exports = router;
