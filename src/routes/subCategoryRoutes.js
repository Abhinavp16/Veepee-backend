const express = require('express');
const router = express.Router();
const subCategories = require('../controllers/subCategoryController');
const { protect, authorize } = require('../middlewares/auth');

// Shoppers: the sub-category cards on a category page.
router.get('/', subCategories.getForCategory);

// Admin
router.get('/admin', protect, authorize('admin', 'staff'), subCategories.adminList);
router.patch('/reorder', protect, authorize('admin', 'staff'), subCategories.reorder);
router.post('/', protect, authorize('admin', 'staff'), subCategories.create);
router.put('/:id', protect, authorize('admin', 'staff'), subCategories.update);
router.delete('/:id', protect, authorize('admin'), subCategories.remove);
router.get('/:id/products', protect, authorize('admin', 'staff'), subCategories.listProducts);
router.post('/:id/products', protect, authorize('admin', 'staff'), subCategories.addProducts);
router.delete('/:id/products/:productId', protect, authorize('admin', 'staff'), subCategories.removeProduct);

module.exports = router;
