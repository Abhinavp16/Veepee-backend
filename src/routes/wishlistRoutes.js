const express = require('express');
const { protect } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { wishlistValidation } = require('../validations');
const wishlistController = require('../controllers/wishlistController');

const router = express.Router();

// The signed-in person's wishlist (any account type).
router.use(protect);
router.get('/', wishlistController.getWishlist);
router.put('/', validate(wishlistValidation.replace), wishlistController.replaceWishlist);
router.post('/:productId', wishlistController.addToWishlist);
router.delete('/:productId', wishlistController.removeFromWishlist);

module.exports = router;
