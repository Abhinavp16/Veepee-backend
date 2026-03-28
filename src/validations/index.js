const Joi = require('joi');

const discountRuleSchema = Joi.object({
  minPurchaseAmount: Joi.number().min(0).required(),
  discountType: Joi.string().valid('percentage', 'fixed').required(),
  discountValue: Joi.number().min(0).required(),
  maxDiscountAmount: Joi.number().min(0).allow('', null),
});

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
    phone: Joi.string().allow('', null),
    address: Joi.string().allow('', null).max(500),
  }),

  fcmToken: Joi.object({
    fcmToken: Joi.string().required(),
  }),
  convertWholesaler: Joi.object({
    businessName: Joi.string().required().max(200),
    gstNumber: Joi.string().allow('', null).max(15),
    businessAddress: Joi.string().required().max(500),
    contactPerson: Joi.string().required().max(100),
    phone: Joi.string().required(),
  }),
};

const productValidation = {
  list: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    category: Joi.string().allow('', null),
    brand: Joi.string().allow('', null),
    minPrice: Joi.number().min(0),
    maxPrice: Joi.number().min(0),
    inStock: Joi.boolean(),
    featured: Joi.boolean(),
    sort: Joi.string().valid('price', '-price', 'name', '-name', 'createdAt', '-createdAt'),
  }),

  search: Joi.object({
    q: Joi.string().allow('', null),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    category: Joi.string().allow('', null),
    brand: Joi.string().allow('', null),
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
    items: Joi.array().items(
      Joi.object({
        productId: Joi.string().required(),
        quantity: Joi.number().integer().min(1).required(),
      })
    ).min(1),
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
    couponCode: Joi.string().trim().uppercase().allow('', null),
    affiliateCode: Joi.string().trim().uppercase().allow('', null),
  }),

  previewCoupon: Joi.object({
    couponCode: Joi.string().trim().uppercase().required(),
    subtotal: Joi.number().min(0),
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
    couponCode: Joi.string().trim().uppercase().allow('', null),
    affiliateCode: Joi.string().trim().uppercase().allow('', null),
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
    labelIds: Joi.array().items(Joi.string()),
    rating: Joi.number().min(0).max(5).default(4.5),
    purchaseCountMin: Joi.number().integer().min(0).default(0),
    purchaseCountMax: Joi.number().integer().min(0).default(0),
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
    labelIds: Joi.array().items(Joi.string()),
    rating: Joi.number().min(0).max(5),
    purchaseCountMin: Joi.number().integer().min(0),
    purchaseCountMax: Joi.number().integer().min(0),
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
    bankName: Joi.string().allow('', null),
    bankAccountNumber: Joi.string().allow('', null),
    bankIfscCode: Joi.string().allow('', null),
    bankAccountHolderName: Joi.string().allow('', null),
    bankTransferEnabled: Joi.boolean(),
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
      buttonText: Joi.string().allow('', null),
      buttonIcon: Joi.string().allow('', null),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    promoBanners: Joi.array().items(Joi.object({
      title: Joi.string().required(),
      subtitle: Joi.string().allow('', null),
      tag: Joi.string().allow('', null),
      imageUrl: Joi.string().allow('', null),
      linkUrl: Joi.string().allow('', null),
      buttonText: Joi.string().allow('', null),
      buttonIcon: Joi.string().allow('', null),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    socialLinks: Joi.object({
      whatsapp: Joi.string().allow('', null),
      instagram: Joi.string().allow('', null),
      facebook: Joi.string().allow('', null),
    }),
  }),

  updateWebsiteSettings: Joi.object({
    heroCards: Joi.array().items(Joi.object({
      image: Joi.string().allow('', null),
      order: Joi.number().integer(),
    })).length(5),
    labels: Joi.array().items(Joi.object({
      id: Joi.string().allow('', null),
      title: Joi.string().required(),
      sourceType: Joi.string().valid('image', 'icon').default('image'),
      image: Joi.string().allow('', null),
      icon: Joi.string().allow('', null),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    productCategories: Joi.array().items(Joi.object({
      name: Joi.string().required(),
      description: Joi.string().allow('', null),
      image: Joi.string().allow('', null),
      products: Joi.array().items(Joi.string().allow('', null)),
      productDetails: Joi.array().items(Joi.object({
        productId: Joi.string().allow('', null),
        name: Joi.string().required(),
        slug: Joi.string().allow('', null),
        category: Joi.string().allow('', null),
        shortDescription: Joi.string().allow('', null),
        description: Joi.string().allow('', null),
        sku: Joi.string().allow('', null),
        mrp: Joi.number().min(0).allow('', null),
        retailPrice: Joi.number().min(0).allow('', null),
        wholesalePrice: Joi.number().min(0).allow('', null),
        stock: Joi.number().min(0).allow('', null),
        status: Joi.string().allow('', null),
        image: Joi.string().allow('', null),
        images: Joi.array().items(Joi.string().allow('', null)),
        order: Joi.number().integer(),
      })),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    featuredProducts: Joi.array().items(Joi.object({
      name: Joi.string().required(),
      price: Joi.string().allow('', null),
      image: Joi.string().allow('', null),
      badge: Joi.string().allow('', null),
      specs: Joi.array().items(Joi.string().allow('', null)),
      shortDescription: Joi.string().allow('', null),
      isActive: Joi.boolean(),
      order: Joi.number().integer(),
    })),
    categoriesSection: Joi.object({
      eyebrow: Joi.string().allow('', null),
      title: Joi.string().allow('', null),
      description: Joi.string().allow('', null),
      buttonText: Joi.string().allow('', null),
    }),
    featuredSection: Joi.object({
      eyebrow: Joi.string().allow('', null),
      title: Joi.string().allow('', null),
      description: Joi.string().allow('', null),
      sideText: Joi.string().allow('', null),
      buttonText: Joi.string().allow('', null),
    }),
  }),

  createOffer: Joi.object({
    title: Joi.string().required().max(200),
    description: Joi.string().allow('', null),
    discountType: Joi.string().valid('percentage', 'fixed').default('percentage'),
    discountValue: Joi.number().min(0).required(),
    discountRules: Joi.array().items(discountRuleSchema).default([]),
    code: Joi.string().uppercase().allow('', null),
    targetGroup: Joi.string().valid('buyer', 'wholesaler', 'all').default('all'),
    startDate: Joi.date().iso().default(Date.now),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).allow('', null),
    imageUrl: Joi.string().uri().allow('', null),
    isActive: Joi.boolean().default(true),
    minPurchaseAmount: Joi.number().min(0).default(0),
    maxDiscountAmount: Joi.number().min(0).allow('', null),
  }),

  updateOffer: Joi.object({
    title: Joi.string().max(200),
    description: Joi.string().allow('', null),
    discountType: Joi.string().valid('percentage', 'fixed'),
    discountValue: Joi.number().min(0),
    discountRules: Joi.array().items(discountRuleSchema),
    code: Joi.string().uppercase().allow('', null),
    targetGroup: Joi.string().valid('buyer', 'wholesaler', 'all'),
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).allow('', null),
    imageUrl: Joi.string().uri().allow('', null),
    isActive: Joi.boolean(),
    minPurchaseAmount: Joi.number().min(0),
    maxDiscountAmount: Joi.number().min(0).allow('', null),
  }),

  createAffiliateCode: Joi.object({
    code: Joi.string().required().uppercase(),
    personName: Joi.string().required().max(100),
    discountType: Joi.string().valid('percentage', 'fixed').default('percentage'),
    discountValue: Joi.number().min(0).required(),
    discountRules: Joi.array().items(discountRuleSchema).default([]),
    usageLimit: Joi.number().integer().min(0).default(0),
    startDate: Joi.date().iso().default(Date.now),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).allow('', null),
    isActive: Joi.boolean().default(true),
  }),

  updateAffiliateCode: Joi.object({
    code: Joi.string().uppercase(),
    personName: Joi.string().max(100),
    discountType: Joi.string().valid('percentage', 'fixed'),
    discountValue: Joi.number().min(0),
    discountRules: Joi.array().items(discountRuleSchema),
    usageLimit: Joi.number().integer().min(0),
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).allow('', null),
    isActive: Joi.boolean(),
  }),

  sendNotification: Joi.object({
    userIds: Joi.array().items(Joi.string().required()).min(1).required(),
    title: Joi.string().required().max(100),
    body: Joi.string().required().max(500),
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
