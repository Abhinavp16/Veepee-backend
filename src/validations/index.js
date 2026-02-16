const Joi = require('joi');

const authValidation = {
  register: Joi.object({
    name: Joi.string().required().max(100),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required(),
    phone: Joi.string().required(),
    role: Joi.string().valid('buyer').default('buyer'),
    marketingConsent: Joi.boolean().default(false),
  }),

  registerWholesaler: Joi.object({
    name: Joi.string().required().max(100),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required(),
    phone: Joi.string().required(),
    businessName: Joi.string().required().max(200),
    gstNumber: Joi.string().allow('', null),
    marketingConsent: Joi.boolean().default(false),
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  loginPhone: Joi.object({
    phone: Joi.string().required().min(10).max(15),
    password: Joi.string().required(),
    expectedRole: Joi.string().valid('buyer', 'wholesaler').optional(),
  }),

  registerPhone: Joi.object({
    name: Joi.string().required().max(100),
    phone: Joi.string().required().min(10).max(15),
    password: Joi.string().min(6).required(),
  }),

  registerPhoneWholesaler: Joi.object({
    name: Joi.string().required().max(100),
    phone: Joi.string().required().min(10).max(15),
    password: Joi.string().min(6).required(),
    businessName: Joi.string().allow('', null).max(200),
  }),

  googleAuth: Joi.object({
    idToken: Joi.string().required(),
    phone: Joi.string().required(),
    marketingConsent: Joi.boolean().default(false),
  }),

  sendOtp: Joi.object({
    phone: Joi.string().required(),
  }),

  verifyPhone: Joi.object({
    phone: Joi.string().required(),
    otp: Joi.string().length(6).required(),
  }),

  refreshToken: Joi.object({
    refreshToken: Joi.string().required(),
  }),

  updateProfile: Joi.object({
    name: Joi.string().max(100),
    avatar: Joi.string().uri().allow('', null),
  }),

  fcmToken: Joi.object({
    fcmToken: Joi.string().required(),
  }),
};

const productValidation = {
  list: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    category: Joi.string(),
    minPrice: Joi.number().min(0),
    maxPrice: Joi.number().min(0),
    inStock: Joi.boolean(),
    featured: Joi.boolean(),
    sort: Joi.string().valid('price', '-price', 'name', '-name', 'createdAt', '-createdAt'),
  }),

  search: Joi.object({
    q: Joi.string().required().min(1),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
  }),
};

const cartValidation = {
  addItem: Joi.object({
    productId: Joi.string().required(),
    quantity: Joi.number().integer().min(1).default(1),
  }),

  updateItem: Joi.object({
    quantity: Joi.number().integer().min(1).required(),
  }),
};

const negotiationValidation = {
  create: Joi.object({
    productId: Joi.string().required(),
    quantity: Joi.number().integer().min(1).required(),
    pricePerUnit: Joi.number().min(0).required(),
    message: Joi.string().max(500).allow('', null),
  }),

  counter: Joi.object({
    pricePerUnit: Joi.number().min(0).required(),
    message: Joi.string().max(500).allow('', null),
  }),
};

const orderValidation = {
  shippingAddress: Joi.object({
    fullName: Joi.string().required().max(100),
    phone: Joi.string().required(),
    addressLine1: Joi.string().required().max(200),
    addressLine2: Joi.string().allow('', null).max(200),
    city: Joi.string().required().max(100),
    state: Joi.string().required().max(100),
    pincode: Joi.string().required().max(10),
  }),

  createFromCart: Joi.object({
    shippingAddress: Joi.object({
      fullName: Joi.string().required().max(100),
      phone: Joi.string().required(),
      addressLine1: Joi.string().required().max(200),
      addressLine2: Joi.string().allow('', null).max(200),
      city: Joi.string().required().max(100),
      state: Joi.string().required().max(100),
      pincode: Joi.string().required().max(10),
    }).required(),
    customerNote: Joi.string().max(500).allow('', null),
  }),

  createFromNegotiation: Joi.object({
    negotiationId: Joi.string().required(),
    shippingAddress: Joi.object({
      fullName: Joi.string().required().max(100),
      phone: Joi.string().required(),
      addressLine1: Joi.string().required().max(200),
      addressLine2: Joi.string().allow('', null).max(200),
      city: Joi.string().required().max(100),
      state: Joi.string().required().max(100),
      pincode: Joi.string().required().max(10),
    }).required(),
    customerNote: Joi.string().max(500).allow('', null),
  }),
};

const adminValidation = {
  createProduct: Joi.object({
    name: Joi.string().required().max(200),
    description: Joi.string().required(),
    shortDescription: Joi.string().max(300),
    category: Joi.string().required(),
    subCategory: Joi.string().allow('', null),
    tags: Joi.array().items(Joi.string()),
    // 3-Tier Pricing
    mrp: Joi.number().min(0).required(),
    retailPrice: Joi.number().min(0).required(),
    wholesalePrice: Joi.number().min(0).required(),
    minWholesaleQuantity: Joi.number().integer().min(1).default(10),
    negotiationEnabled: Joi.boolean().default(true),
    sku: Joi.string().required(),
    stock: Joi.number().integer().min(0).default(0),
    lowStockThreshold: Joi.number().integer().min(0).default(5),
    images: Joi.array().items(Joi.object({
      url: Joi.string().required(),
      publicId: Joi.string().required(),
      isPrimary: Joi.boolean().default(false),
      order: Joi.number().default(0),
    })),
    specifications: Joi.array().items(Joi.object({
      key: Joi.string().required(),
      value: Joi.string().required(),
    })),
    status: Joi.string().valid('active', 'draft', 'archived').default('draft'),
    isFeatured: Joi.boolean().default(false),
    isHot: Joi.boolean().default(false),
    company: Joi.string().allow('', null),
    videoUrl: Joi.string().allow('', null),
    shippingTerms: Joi.string().allow('', null),
  }),

  updateProduct: Joi.object({
    name: Joi.string().max(200),
    description: Joi.string(),
    shortDescription: Joi.string().max(300),
    category: Joi.string(),
    subCategory: Joi.string().allow('', null),
    tags: Joi.array().items(Joi.string()),
    // 3-Tier Pricing
    mrp: Joi.number().min(0),
    retailPrice: Joi.number().min(0),
    wholesalePrice: Joi.number().min(0),
    minWholesaleQuantity: Joi.number().integer().min(1),
    negotiationEnabled: Joi.boolean(),
    stock: Joi.number().integer().min(0),
    lowStockThreshold: Joi.number().integer().min(0),
    images: Joi.array().items(Joi.object({
      url: Joi.string().required(),
      publicId: Joi.string().required(),
      isPrimary: Joi.boolean().default(false),
      order: Joi.number().default(0),
    })),
    specifications: Joi.array().items(Joi.object({
      key: Joi.string().required(),
      value: Joi.string().required(),
    })),
    status: Joi.string().valid('active', 'draft', 'archived'),
    isFeatured: Joi.boolean(),
    isHot: Joi.boolean(),
    company: Joi.string().allow('', null),
    videoUrl: Joi.string().allow('', null),
    shippingTerms: Joi.string().allow('', null),
  }),

  updateStock: Joi.object({
    stock: Joi.number().integer().min(0),
    adjustment: Joi.string().pattern(/^[+-]\d+$/),
    reason: Joi.string().max(200),
  }).or('stock', 'adjustment'),

  counterNegotiation: Joi.object({
    pricePerUnit: Joi.number().min(0).required(),
    message: Joi.string().max(500).allow('', null),
  }),

  rejectNegotiation: Joi.object({
    reason: Joi.string().max(500).allow('', null),
  }),

  updateOrderStatus: Joi.object({
    status: Joi.string().valid('processing', 'shipped', 'delivered', 'cancelled').required(),
    note: Joi.string().max(500).allow('', null),
  }),

  shipOrder: Joi.object({
    trackingNumber: Joi.string().required(),
    courierName: Joi.string().required(),
  }),

  rejectPayment: Joi.object({
    reason: Joi.string().required().max(500),
  }),

  updateSettings: Joi.object({
    businessName: Joi.string().max(200),
    businessPhone: Joi.string(),
    businessEmail: Joi.string().email(),
    businessAddress: Joi.string(),
    upiId: Joi.string(),
    upiDisplayName: Joi.string(),
    minOrderAmount: Joi.number().min(0),
    defaultBulkMinQuantity: Joi.number().integer().min(1),
    negotiationExpiryDays: Joi.number().integer().min(1),
    lowStockThreshold: Joi.number().integer().min(0),
    features: Joi.object({
      negotiationsEnabled: Joi.boolean(),
      guestCheckout: Joi.boolean(),
      maintenanceMode: Joi.boolean(),
    }),
    heroBanners: Joi.array().items(Joi.object({
      title: Joi.string().required(),
      subtitle: Joi.string().allow('', null),
      tag: Joi.string().allow('', null),
      imageUrl: Joi.string().allow('', null),
      linkUrl: Joi.string().allow('', null),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    promoBanners: Joi.array().items(Joi.object({
      title: Joi.string().required(),
      subtitle: Joi.string().allow('', null),
      tag: Joi.string().allow('', null),
      imageUrl: Joi.string().allow('', null),
      linkUrl: Joi.string().allow('', null),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    socialLinks: Joi.object({
      whatsapp: Joi.string().allow('', null),
      instagram: Joi.string().allow('', null),
      facebook: Joi.string().allow('', null),
    }),
  }),
};

module.exports = {
  authValidation,
  productValidation,
  cartValidation,
  negotiationValidation,
  orderValidation,
  adminValidation,
};
