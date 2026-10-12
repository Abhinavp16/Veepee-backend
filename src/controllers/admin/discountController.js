const mongoose = require('mongoose');
const { Company, Category } = require('../../models');
const { NotFoundError, BadRequestError } = require('../../utils/errors');

const FIELDS = '+customerDiscountPercent +wholesalerDiscountPercent';
const MODELS = { company: Company, category: Category };

const row = (doc) => ({
  id: doc._id,
  name: doc.name,
  customerDiscountPercent: doc.customerDiscountPercent || 0,
  wholesalerDiscountPercent: doc.wholesalerDiscountPercent || 0,
});

// All brands and categories with their current discount percentages.
exports.listDiscounts = async (req, res, next) => {
  try {
    const [companies, categories] = await Promise.all([
      Company.find({}).select(`name ${FIELDS}`).sort({ name: 1 }).lean(),
      Category.find({}).select(`name ${FIELDS}`).sort({ name: 1 }).lean(),
    ]);
    res.json({
      success: true,
      data: { companies: companies.map(row), categories: categories.map(row) },
    });
  } catch (error) {
    next(error);
  }
};

// Percentages are off MRP. 0 means "no discount" for that audience.
exports.setDiscount = async (req, res, next) => {
  try {
    const Model = MODELS[req.params.kind];
    if (!Model) throw new BadRequestError('Unknown discount target', 'INVALID_DISCOUNT_TARGET');
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw new NotFoundError('Not found', 'NOT_FOUND');
    }

    const update = {};
    for (const key of ['customerDiscountPercent', 'wholesalerDiscountPercent']) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const doc = await Model.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .select(`name ${FIELDS}`)
      .lean();
    if (!doc) throw new NotFoundError('Not found', 'NOT_FOUND');

    res.json({ success: true, data: row(doc) });
  } catch (error) {
    next(error);
  }
};
