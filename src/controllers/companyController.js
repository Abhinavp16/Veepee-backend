const mongoose = require('mongoose');
const { Company, Product, Category } = require('../models');
const { NotFoundError, ConflictError, BadRequestError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');
const { PRODUCT_STATUS } = require('../utils/constants');
const { categoryProductCondition } = require('../utils/categoryHelpers');
const { createGlobalCategory, removeCreatedCategory } = require('../services/categoryService');
const { getCompanyCategoryCounts, sortCategoriesByTree } = require('../utils/companyCategoryHelpers');

function validateId(value, field) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new BadRequestError(`${field} must be a valid ID`, `INVALID_${field.replace(/Id$/, '').toUpperCase()}_ID`);
  }
}

async function getCompanyDirectProductSets(companyId, categories) {
  if (categories.length === 0) return new Map();
  const grouped = await Product.aggregate([
    { $match: { company: new mongoose.Types.ObjectId(String(companyId)), status: { $ne: PRODUCT_STATUS.ARCHIVED } } },
    { $project: { category: 1, categoryIds: { $ifNull: ['$categoryIds', []] } } },
    {
      $facet: {
        canonical: [
          { $unwind: '$categoryIds' },
          { $group: { _id: '$categoryIds', productIds: { $addToSet: '$_id' } } },
        ],
        legacy: [
          { $match: { categoryIds: { $size: 0 } } },
          { $group: { _id: '$category', productIds: { $addToSet: '$_id' } } },
        ],
      },
    },
  ]);
  const canonical = new Map((grouped[0]?.canonical || []).map((item) => [String(item._id), item.productIds]));
  const legacy = new Map((grouped[0]?.legacy || []).map((item) => [item._id, item.productIds]));
  return new Map(categories.map((category) => [String(category._id), new Set([
    ...(canonical.get(String(category._id)) || []),
    ...(legacy.get(category.slug) || []),
  ].map(String))]));
}

exports.getAllCompanies = async (req, res, next) => {
  try {
    const { active, search } = req.query;
    const { page, limit, skip } = paginate(req.query.page, req.query.limit);

    const query = {};
    if (active !== undefined) {
      query.isActive = active === 'true';
    }
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
      ];
    }

    const [companies, total] = await Promise.all([
      Company.find(query).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Company.countDocuments(query),
    ]);

    res.json({
      success: true,
      ...formatPaginationResponse(companies, total, page, limit),
    });
  } catch (error) {
    next(error);
  }
};

exports.getCompanyById = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    
    if (!company) {
      throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    }

    res.json({
      success: true,
      data: company,
    });
  } catch (error) {
    next(error);
  }
};

exports.createCompany = async (req, res, next) => {
  try {
    const { name, description, website, logo } = req.body;

    const existingCompany = await Company.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });
    
    if (existingCompany) {
      throw new ConflictError('Company with this name already exists', 'COMPANY_EXISTS');
    }

    const company = await Company.create({
      name,
      description,
      website,
      logo,
    });

    res.status(201).json({
      success: true,
      message: 'Company created successfully',
      data: company,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateCompany = async (req, res, next) => {
  try {
    const { name, description, website, logo, isActive } = req.body;

    const company = await Company.findById(req.params.id);
    
    if (!company) {
      throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    }

    if (name && name !== company.name) {
      const existingCompany = await Company.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: company._id }
      });
      
      if (existingCompany) {
        throw new ConflictError('Company with this name already exists', 'COMPANY_EXISTS');
      }
      company.name = name;
    }

    if (description !== undefined) company.description = description;
    if (website !== undefined) company.website = website;
    if (logo !== undefined) company.logo = logo;
    if (isActive !== undefined) company.isActive = isActive;

    await company.save();

    res.json({
      success: true,
      message: 'Company updated successfully',
      data: company,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    
    if (!company) {
      throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    }

    // Check if any products are linked to this company
    const productCount = await Product.countDocuments({ company: company._id });
    if (productCount > 0) {
      throw new ConflictError(
        `Cannot delete company. ${productCount} product(s) are linked to it.`,
        'COMPANY_HAS_PRODUCTS'
      );
    }

    await company.deleteOne();

    res.json({
      success: true,
      message: 'Company deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.getCompanyProducts = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    
    if (!company) {
      throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    }

    const products = await Product.find({ company: company._id })
      .select('name slug retailPrice images status')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        company,
        products,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getCompanyCategories = async (req, res, next) => {
  try {
    validateId(req.params.companyId, 'companyId');
    const company = await Company.findById(req.params.companyId).lean();
    if (!company) throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');

    const categories = await Category.find({ _id: { $in: company.categoryIds || [] } })
      .populate('parent', 'name slug')
      .lean();
    const directSets = await getCompanyDirectProductSets(company._id, categories);
    const counts = getCompanyCategoryCounts(categories, directSets);
    const data = sortCategoriesByTree(categories).map((category) => ({
      ...category,
      ...(counts.get(String(category._id)) || { directProductCount: 0, recursiveProductCount: 0 }),
    }));

    res.json({ success: true, data: { company, categories: data } });
  } catch (error) {
    next(error);
  }
};

exports.createCompanyCategory = async (req, res, next) => {
  let createdCategory;
  try {
    validateId(req.params.companyId, 'companyId');
    if (!await Company.exists({ _id: req.params.companyId })) {
      throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    }
    createdCategory = await createGlobalCategory(req.body);
    const company = await Company.findByIdAndUpdate(
      req.params.companyId,
      { $addToSet: { categoryIds: createdCategory._id } },
      { new: true }
    );
    if (!company) throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    res.status(201).json({ success: true, data: createdCategory });
  } catch (error) {
    if (createdCategory) {
      try {
        await removeCreatedCategory(createdCategory);
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
    }
    next(error);
  }
};

exports.linkCompanyCategory = async (req, res, next) => {
  try {
    validateId(req.params.companyId, 'companyId');
    validateId(req.params.categoryId, 'categoryId');
    const category = await Category.findById(req.params.categoryId);
    if (!category) throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
    const company = await Company.findByIdAndUpdate(
      req.params.companyId,
      { $addToSet: { categoryIds: category._id } },
      { new: true }
    );
    if (!company) throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    res.json({ success: true, data: category });
  } catch (error) {
    next(error);
  }
};

exports.unlinkCompanyCategory = async (req, res, next) => {
  try {
    validateId(req.params.companyId, 'companyId');
    validateId(req.params.categoryId, 'categoryId');
    const [company, category] = await Promise.all([
      Company.findById(req.params.companyId),
      Category.findById(req.params.categoryId).select('_id slug'),
    ]);
    if (!company) throw new NotFoundError('Company not found', 'COMPANY_NOT_FOUND');
    if (!category) throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');

    const productCount = await Product.countDocuments({
      company: company._id,
      ...categoryProductCondition(category),
    });
    if (productCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot unlink category. ${productCount} product(s) in this company reference it.`,
        error: { code: 'COMPANY_CATEGORY_HAS_PRODUCTS', count: productCount },
      });
    }

    company.categoryIds = (company.categoryIds || []).filter((id) => String(id) !== String(category._id));
    await company.save();
    res.json({ success: true, message: 'Category unlinked from company successfully' });
  } catch (error) {
    next(error);
  }
};
