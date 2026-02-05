const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const productImageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'agrimart/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1000, height: 1000, crop: 'limit', quality: 'auto' }],
  },
});

const paymentScreenshotStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'agrimart/payments',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    transformation: [{ width: 1500, height: 2000, crop: 'limit', quality: 'auto' }],
  },
});

const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'agrimart/avatars',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face' }],
  },
});

const uploadProductImages = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const uploadPaymentScreenshot = multer({
  storage: paymentScreenshotStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
});

const deleteImage = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    return true;
  } catch (error) {
    console.error('Error deleting image from Cloudinary:', error);
    return false;
  }
};

module.exports = {
  cloudinary,
  uploadProductImages,
  uploadPaymentScreenshot,
  uploadAvatar,
  deleteImage,
};
