const { Company, Product } = require('../models');
const { NotFoundError, ConflictError } = require('../utils/errors');
const { paginate, formatPaginationResponse } = require('../utils/helpers');

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
