const mongoose = require('mongoose');

const websiteCategorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  image: String,
  products: [{ type: String }],
  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { _id: false });

const websiteFeaturedProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: String,
  image: String,
  badge: String,
  specs: [{ type: String }],
  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { _id: false });

const websiteHeroCardSchema = new mongoose.Schema({
  image: String,
  order: { type: Number, default: 0 },
}, { _id: false });

const websiteSectionConfigSchema = new mongoose.Schema({
  eyebrow: String,
  title: String,
  description: String,
  sideText: String,
  buttonText: String,
}, { _id: false });

const defaultHeroCards = [
  '/images/Banner/1.jpg',
  '/images/Banner/2.jpg',
  '/images/Banner/3.jpg',
  '/images/Banner/4.jpg',
  '/images/Banner/5.jpg',
].map((image, order) => ({ image, order }));

const websiteSettingsSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: 'website_settings',
  },
  heroCards: {
    type: [websiteHeroCardSchema],
    default: defaultHeroCards,
  },
  productCategories: {
    type: [websiteCategorySchema],
    default: [],
  },
  featuredProducts: {
    type: [websiteFeaturedProductSchema],
    default: [],
  },
  categoriesSection: {
    type: websiteSectionConfigSchema,
    default: {
      eyebrow: 'PRODUCT CATEGORIES',
      title: 'The Heart of Modern Farming',
      description: 'Our diverse range of agriculture and industrial machines stands at the core of modern farming practices. Each piece of equipment is designed with utmost precision.',
      buttonText: 'Inquire Now',
    },
  },
  featuredSection: {
    type: websiteSectionConfigSchema,
    default: {
      eyebrow: 'PRECISION ENGINEERING',
      title: 'Our Popular Product',
      sideText: 'Genuine Oxon products engineered for durability, performance, and maximum ROI.',
      buttonText: 'Get Quote',
    },
  },
}, {
  timestamps: true,
});

websiteSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById('website_settings');

  if (!settings) {
    settings = await this.create({
      _id: 'website_settings',
      heroCards: defaultHeroCards,
      productCategories: [],
      featuredProducts: [],
      categoriesSection: {
        eyebrow: 'PRODUCT CATEGORIES',
        title: 'The Heart of Modern Farming',
        description: 'Our diverse range of agriculture and industrial machines stands at the core of modern farming practices. Each piece of equipment is designed with utmost precision.',
        buttonText: 'Inquire Now',
      },
      featuredSection: {
        eyebrow: 'PRECISION ENGINEERING',
        title: 'Our Popular Product',
        sideText: 'Genuine Oxon products engineered for durability, performance, and maximum ROI.',
        buttonText: 'Get Quote',
      },
    });
  }

  if (!Array.isArray(settings.heroCards) || settings.heroCards.length !== 5) {
    settings.heroCards = defaultHeroCards;
    await settings.save();
  }

  return settings;
};

module.exports = mongoose.model('WebsiteSettings', websiteSettingsSchema);
