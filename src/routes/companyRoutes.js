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
router.get('/:id', companyController.getCompanyById);
router.get('/:id/products', companyController.getCompanyProducts);

// Admin routes
router.post('/', protect, authorize('admin'), validate(companyValidation.create), companyController.createCompany);
router.put('/:id', protect, authorize('admin'), validate(companyValidation.update), companyController.updateCompany);
router.delete('/:id', protect, authorize('admin'), companyController.deleteCompany);

module.exports = router;
