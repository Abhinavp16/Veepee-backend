const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middlewares/auth');
const { uploadAvatar, uploadProductImages } = require('../config/cloudinary');
const validate = require('../middlewares/validate');
const { authValidation } = require('../validations');

router.post('/register', validate(authValidation.register), authController.register);
router.post('/register/wholesaler', validate(authValidation.registerWholesaler), authController.registerWholesaler);
router.post('/register-phone', validate(authValidation.registerPhone), authController.registerWithPhone);
router.post('/register-phone/wholesaler', validate(authValidation.registerPhoneWholesaler), authController.registerWholesalerWithPhone);
router.post('/login', validate(authValidation.login), authController.login);
router.post('/login-phone', validate(authValidation.loginPhone), authController.loginWithPhone);
router.post('/google', validate(authValidation.googleAuth), authController.googleAuth);
router.post('/send-otp', validate(authValidation.sendOtp), authController.sendOtp);
router.post('/verify-phone', validate(authValidation.verifyPhone), authController.verifyPhone);
router.post('/refresh-token', validate(authValidation.refreshToken), authController.refreshToken);
router.post('/logout', protect, authController.logout);
router.get('/me', protect, authController.getMe);
router.put('/profile', protect, validate(authValidation.updateProfile), authController.updateProfile);
router.post('/profile/avatar', protect, uploadAvatar.single('avatar'), authController.uploadProfileAvatar);
router.post('/fcm-token', protect, validate(authValidation.fcmToken), authController.registerFcmToken);
router.post('/convert-to-wholesaler', protect, uploadProductImages.array('proofImages', 3), validate(authValidation.convertWholesaler), authController.convertToWholesaler);

module.exports = router;

