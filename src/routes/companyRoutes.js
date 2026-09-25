const express = require('express');
const router = express.Router();
const companyController = require('../controllers/companyController');
const { protect, authorize } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const Joi = require('joi');

const companyValidation = {
  create: Joi.object({
    name: Joi.string().required().max(100),
    description: Joi.string().max(500).allow('', null),
    website: Joi.string().uri().allow('', null),
    logo: Joi.object({
      url: Joi.string().uri().allow('', null),
      publicId: Joi.string().allow('', null),
    }).allow(null),
  }),
  update: Joi.object({
    name: Joi.string().max(100),
    description: Joi.string().max(500).allow('', null),
    website: Joi.string().uri().allow('', null),
    logo: Joi.object({
      url: Joi.string().uri().allow('', null),
      publicId: Joi.string().allow('', null),
    }).allow(null),
    isActive: Joi.boolean(),
  }),
};

// Public routes
router.get('/', companyController.getAllCompanies);
router.get('/:companyId/categories', protect, authorize('admin', 'staff'), companyController.getCompanyCategories);
router.post('/:companyId/categories', protect, authorize('admin', 'staff'), companyController.createCompanyCategory);
router.put('/:companyId/categories/:categoryId', protect, authorize('admin', 'staff'), companyController.linkCompanyCategory);
router.delete('/:companyId/categories/:categoryId', protect, authorize('admin'), companyController.unlinkCompanyCategory);
router.get('/:id', companyController.getCompanyById);
router.get('/:id/products', companyController.getCompanyProducts);

// Admin routes
router.post('/', protect, authorize('admin', 'staff'), validate(companyValidation.create), companyController.createCompany);
router.put('/:id', protect, authorize('admin', 'staff'), validate(companyValidation.update), companyController.updateCompany);
router.delete('/:id', protect, authorize('admin'), companyController.deleteCompany);

module.exports = router;
