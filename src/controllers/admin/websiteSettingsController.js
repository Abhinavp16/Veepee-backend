const { WebsiteSettings } = require('../../models');
const mongoose = require('mongoose');

const normalizeLabel = (label = {}, order = 0) => ({
  ...(typeof label?.toObject === 'function' ? label.toObject() : label),
  id: String(label?.id || new mongoose.Types.ObjectId()),
  title: String(label?.title || '').trim(),
  sourceType: label?.sourceType === 'image' ? 'image' : 'icon',
  image: String(label?.image || '').trim(),
  icon: String(label?.icon || '').trim(),
  isActive: label?.isActive !== false,
  order: Number.isFinite(label?.order) ? label.order : order,
});

exports.getWebsiteSettings = async (req, res, next) => {
  try {
    const settings = await WebsiteSettings.getSettings();
    res.json({
      success: true,
      data: settings,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateWebsiteSettings = async (req, res, next) => {
  try {
    let settings = await WebsiteSettings.findById('website_settings');
    if (!settings) {
      settings = new WebsiteSettings({ _id: 'website_settings' });
    }

    const allowedFields = ['heroCards', 'labels', 'productCategories', 'featuredProducts', 'categoriesSection', 'featuredSection'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        settings[field] = req.body[field];
      }
    }

    if (Array.isArray(settings.labels)) {
      settings.labels = settings.labels.map((label, index) => normalizeLabel(label, index));
    }

    if (!Array.isArray(settings.heroCards) || settings.heroCards.length !== 5) {
      return res.status(400).json({
        success: false,
        message: 'heroCards must contain exactly 5 items',
      });
    }

    await settings.save();

    res.json({
      success: true,
      message: 'Website settings updated successfully',
      data: settings,
    });
  } catch (error) {
    next(error);
  }
};
