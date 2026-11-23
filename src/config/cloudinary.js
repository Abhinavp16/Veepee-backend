const multer = require('multer');
const { getStorage } = require('./firebase');
const { BadRequestError } = require('../utils/errors');

// All file uploads use memory storage — Firebase Storage handles persistence
const memoryStorage = multer.memoryStorage();

const uploadProductImages = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Only JPEG, PNG, and WebP images are allowed', 'INVALID_FILE_TYPE'), false);
    }
  },
});

const uploadAvatar = multer({
  storage: memoryStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Only JPEG and PNG images are allowed', 'INVALID_FILE_TYPE'), false);
    }
  },
});

// Wholesaler proof photos: 1-3 JPG, PNG or WebP photos up to 5 MB each.
// Anything else (HEIC, PDF, too large, too many) is a 400 with a message the
// app can show. A file sent without a type is accepted by its name; the
// photo itself is checked when it is converted.
const PROOF_MAX_FILES = 3;
const PROOF_FILE_MESSAGE = 'Use a JPG, PNG or WebP photo up to 5 MB.';
const PROOF_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const PROOF_EXTENSION = /\.(jpe?g|png|webp)$/i;

const proofImagesUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: PROOF_MAX_FILES },
  fileFilter: (req, file, cb) => {
    const typed = PROOF_TYPES.includes(String(file.mimetype).toLowerCase());
    const untyped = ['application/octet-stream', ''].includes(String(file.mimetype || '').toLowerCase())
      && PROOF_EXTENSION.test(file.originalname || '');
    if (typed || untyped) cb(null, true);
    else cb(new BadRequestError(PROOF_FILE_MESSAGE, 'PROOF_FILE_INVALID'), false);
  },
}).array('proofImages', PROOF_MAX_FILES);

const uploadProofImages = (req, res, next) => {
  proofImagesUpload(req, res, (error) => {
    if (!error) return next();
    if (error.name === 'MulterError') {
      if (error.code === 'LIMIT_FILE_SIZE') return next(new BadRequestError(PROOF_FILE_MESSAGE, 'PROOF_FILE_INVALID'));
      if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
        return next(new BadRequestError(`Add up to ${PROOF_MAX_FILES} proof photos.`, 'TOO_MANY_PROOFS'));
      }
    }
    return next(error);
  });
};

const deleteImage = async (publicId) => {
  try {
    const bucket = getStorage();
    if (!bucket) {
      console.warn('Firebase Storage not configured, cannot delete image');
      return false;
    }
    const file = bucket.file(publicId);
    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
    }
    return true;
  } catch (error) {
    console.error('Error deleting image from Firebase Storage:', error);
    return false;
  }
};

module.exports = {
  uploadProductImages,
  uploadAvatar,
  uploadProofImages,
  deleteImage,
};
