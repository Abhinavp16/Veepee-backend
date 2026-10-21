const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const accountDeletionController = require('../controllers/accountDeletionController');
const { protect, authorize, buyerOrWholesaler } = require('../middlewares/auth');
const { uploadAvatar, uploadProductImages } = require('../config/cloudinary');
const validate = require('../middlewares/validate');
const { createAuthLimiter } = require('../middlewares/rateLimits');
const { authValidation } = require('../validations');

// Failed sign-ins, sign-ups and code requests are limited per phone/email and
// per address; successful ones are never counted.
const authLimiter = createAuthLimiter();

router.post('/register', authLimiter, validate(authValidation.register), authController.register);
router.post('/register/wholesaler', authLimiter, validate(authValidation.registerWholesaler), authController.registerWholesaler);
router.post('/register-phone', authLimiter, validate(authValidation.registerPhone), authController.registerWithPhone);
router.post('/register-phone/wholesaler', authLimiter, validate(authValidation.registerPhoneWholesaler), authController.registerWholesalerWithPhone);
router.post('/login', authLimiter, validate(authValidation.login), authController.login);
router.post('/staff-login', authLimiter, validate(authValidation.staffLogin), authController.staffLogin);
router.post('/login-phone', authLimiter, validate(authValidation.loginPhone), authController.loginWithPhone);
router.post('/send-otp', authLimiter, validate(authValidation.sendOtp), authController.sendOtp);
router.post('/verify-phone', authLimiter, validate(authValidation.verifyPhone), authController.verifyPhone);
router.post('/refresh-token', validate(authValidation.refreshToken), authController.refreshToken);
router.post('/logout', protect, validate(authValidation.logout), authController.logout);
router.put('/preferences', protect, validate(authValidation.updatePreferences), authController.updatePreferences);
router.post('/change-password', protect, authLimiter, validate(authValidation.changePassword), authController.changePassword);
router.get('/me', protect, authController.getMe);
router.put('/profile', protect, validate(authValidation.updateProfile), authController.updateProfile);
router.get('/addresses', protect, authController.getAddresses);
router.put('/addresses', protect, validate(authValidation.saveAddresses), authController.saveAddresses);
router.post('/profile/avatar', protect, uploadAvatar.single('avatar'), authController.uploadProfileAvatar);
router.post('/fcm-token', protect, buyerOrWholesaler, validate(authValidation.fcmToken), authController.registerFcmToken);
router.post('/convert-to-wholesaler', protect, buyerOrWholesaler, uploadProductImages.array('proofImages', 3), validate(authValidation.convertWholesaler), authController.convertToWholesaler);

// Account deletion: customers only (admin and staff accounts are not self-service).
const customerOnly = authorize('buyer', 'wholesaler');
router.get('/account-deletion-request', protect, customerOnly, accountDeletionController.getMyRequest);
router.post('/account-deletion-request', protect, customerOnly, validate(authValidation.requestAccountDeletion), accountDeletionController.requestMyAccountDeletion);
router.post('/account-deletion-request/cancel', protect, customerOnly, accountDeletionController.cancelMyAccountDeletion);

module.exports = router;

