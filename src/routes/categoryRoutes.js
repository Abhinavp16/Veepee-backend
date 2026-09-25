const express = require('express');
const router = express.Router();
const {
  getCategories,
  getCategory,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  reorderCategories,
  deleteCategory,
} = require('../controllers/categoryController');
const { protect, authorize } = require('../middlewares/auth');

// Public routes
router.get('/', getCategories);
router.get('/slug/:slug', getCategoryBySlug);
router.patch('/reorder', protect, authorize('admin', 'staff'), reorderCategories);
router.get('/:id', getCategory);

// Admin routes
router.post('/', protect, authorize('admin', 'staff'), createCategory);
router.put('/:id', protect, authorize('admin', 'staff'), updateCategory);
router.delete('/:id', protect, authorize('admin'), deleteCategory);

module.exports = router;
