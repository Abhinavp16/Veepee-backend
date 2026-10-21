const Joi = require('joi');
const { validateIndianPhoneJoi } = require('../utils/phoneValidator');

const indianPhone = Joi.string()
  .custom(validateIndianPhoneJoi)
  .messages({ 'any.invalid': 'Please provide a valid Indian mobile number' });

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const categoryIds = Joi.alternatives().try(
  Joi.array().items(objectId).min(1),
  Joi.string().trim().min(1)
);

const storeUrl = Joi.string()
  .uri({ scheme: ['https'] })
  .pattern(/^https:\/\/(play\.google\.com|apps\.apple\.com)\//)
  .allow('')
  .messages({ 'string.pattern.base': 'Store URL must be a Google Play or App Store link' });

const platformUpdate = Joi.object({
  enabled: Joi.boolean(),
  latestVersion: Joi.string().allow('').max(32),
  latestBuildNumber: Joi.number().integer().min(0),
  storeUrl,
  title: Joi.string().allow('').max(80),
  message: Joi.string().allow('').max(300),
});

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
    phone: indianPhone.required(),
    role: Joi.string().valid('buyer').default('buyer'),
    marketingConsent: Joi.boolean().default(false),
  }),

  registerWholesaler: Joi.object({
    name: Joi.string().required().max(100),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required(),
    phone: indianPhone.required(),
    businessName: Joi.string().required().max(200),
    gstNumber: Joi.string().allow('', null),
    marketingConsent: Joi.boolean().default(false),
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  staffLogin: Joi.object({
    email: Joi.string().email().lowercase().required(),
    password: Joi.string().required(),
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).max(128).required(),
  }),

  loginPhone: Joi.object({
    phone: Joi.string().required().min(10).max(15),
    password: Joi.string().required(),
    expectedRole: Joi.string().valid('buyer', 'wholesaler').optional(),
  }),

  registerPhone: Joi.object({
    name: Joi.string().required().max(100),
    phone: indianPhone.required(),
    password: Joi.string().min(6).required(),
    termsAccepted: Joi.boolean(),
    privacyPolicyAccepted: Joi.boolean(),
    termsVersion: Joi.string().max(32),
    privacyPolicyVersion: Joi.string().max(32),
  }),

  registerPhoneWholesaler: Joi.object({
    name: Joi.string().required().max(100),
    phone: indianPhone.required(),
    password: Joi.string().min(6).required(),
    businessName: Joi.string().allow('', null).max(200),
    termsAccepted: Joi.boolean(),
    privacyPolicyAccepted: Joi.boolean(),
    termsVersion: Joi.string().max(32),
    privacyPolicyVersion: Joi.string().max(32),
  }),

  saveAddresses: Joi.object({
    addresses: Joi.array()
      .items(
        Joi.object({
          id: Joi.string().trim().min(1).max(64).required(),
          slot: Joi.string().valid('primary', 'secondary').required(),
          fullName: Joi.string().trim().min(1).max(100).required(),
          phone: Joi.string().trim().pattern(/^\d{10}$/).required()
            .messages({ 'string.pattern.base': 'Phone must be 10 digits' }),
          addressLine1: Joi.string().trim().min(1).max(300).required(),
          city: Joi.string().trim().min(1).max(100).required(),
          state: Joi.string().trim().min(1).max(100).required(),
          pincode: Joi.string().trim().pattern(/^[1-9]\d{5}$/).required()
            .messages({ 'string.pattern.base': 'Pincode must be 6 digits' }),
        })
      )
      .max(2)
      .unique('slot')
      .unique('id')
      .required(),
    selectedAddressId: Joi.string().trim().max(64).allow(null, ''),
  }),

  updatePreferences: Joi.object({
    language: Joi.string().valid('en', 'hi').required(),
  }),

  sendOtp: Joi.object({
    phone: indianPhone.required(),
  }),

  verifyPhone: Joi.object({
    phone: indianPhone.required(),
    otp: Joi.string().length(6).required(),
  }),

  logout: Joi.object({
    refreshToken: Joi.string().allow('', null),
    fcmToken: Joi.string().allow('', null),
  }),

  refreshToken: Joi.object({
    refreshToken: Joi.string().required(),
  }),

  requestAccountDeletion: Joi.object({}),

  // Lenient phone rule: older accounts were never format-checked.
  publicAccountDeletionRequest: Joi.object({
    name: Joi.string().trim().max(100).required(),
    phone: Joi.string().trim().min(10).max(15).required(),
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
    category: Joi.string().max(100).allow('', null),
    categorySlug: Joi.string().trim().lowercase().max(100).allow('', null),
    brand: Joi.string().max(200).allow('', null),
    minPrice: Joi.number().min(0),
    maxPrice: Joi.number().min(0),
    inStock: Joi.boolean(),
    featured: Joi.boolean(),
    isFeatured: Joi.boolean(),
    isHot: Joi.boolean(),
    comingSoon: Joi.boolean(),
    includeComingSoon: Joi.boolean(),
    sort: Joi.string().valid('price', '-price', 'name', '-name', 'createdAt', '-createdAt'),
  }),

  search: Joi.object({
    q: Joi.string().max(200).allow('', null),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    category: Joi.string().max(100).allow('', null),
    categorySlug: Joi.string().trim().lowercase().max(100).allow('', null),
    brand: Joi.string().max(200).allow('', null),
    comingSoon: Joi.boolean(),
    includeComingSoon: Joi.boolean(),
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

  fromCart: Joi.object({
    message: Joi.string().max(500).allow('', null),
    // Optional own prices; every other line is asked at its current wholesale price.
    offers: Joi.array().items(Joi.object({
      productId: objectId.required(),
      pricePerUnit: Joi.number().greater(0).required(),
    })).max(100),
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
    // The unit prices the buyer was looking at (stops the order if one changed).
    expectedPrices: Joi.array().max(200).items(Joi.object({
      productId: Joi.string().required(),
      price: Joi.number().min(0).required(),
    })),
    couponCode: Joi.string().trim().uppercase().allow('', null),
    affiliateCode: Joi.string().trim().uppercase().allow('', null),
  }),

  previewCoupon: Joi.object({
    couponCode: Joi.string().trim().uppercase().required(),
    subtotal: Joi.number().min(0),
    // Buy Now: the item, so sale prices are left out of the coupon.
    items: Joi.array().max(50).items(Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
    })),
  }),

  createFromGroup: Joi.object({
    groupId: Joi.string().guid().required(),
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

// Sale pages (Diwali Sale, Stock Clearance, ...).
const salePercent = Joi.number().integer().min(1).max(90).allow(null);
const saleBody = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  nameHindi: Joi.string().trim().max(80).allow(''),
  subtitle: Joi.string().trim().max(140).allow(''),
  subtitleHindi: Joi.string().trim().max(140).allow(''),
  theme: Joi.string().valid('diwali', 'clearance', 'flash', 'kisan').required(),
  heroImageUrl: Joi.string().trim().max(1000).allow(''),
  audience: Joi.string().valid('customers', 'wholesalers', 'both').required(),
  customerPercent: salePercent,
  wholesalerPercent: salePercent,
  startsAt: Joi.date().required(),
  endsAt: Joi.date().greater(Joi.ref('startsAt')).required()
    .messages({ 'date.greater': 'The end must be after the start' }),
  status: Joi.string().valid('draft', 'published').required(),
  products: Joi.array().max(200).items(Joi.object({
    productId: Joi.string().hex().length(24).required(),
    customerPercent: salePercent,
    wholesalerPercent: salePercent,
    saleQuantity: Joi.number().integer().min(1).max(1000000).allow(null),
    perPersonLimit: Joi.number().integer().min(1).max(100000).allow(null),
  })).unique('productId').required(),
});

const adminValidation = {
  createSale: saleBody,
  updateSale: saleBody,
  // The editor's unsaved form (a name may not be typed yet).
  previewSale: saleBody.keys({
    name: Joi.string().trim().max(80).allow(''),
    saleId: Joi.string().hex().length(24).allow(null, ''),
  }),
  createProduct: Joi.object({
    name: Joi.string().required().max(200),
    description: Joi.string().required(),
    shortDescription: Joi.string().max(300),
    category: Joi.string(),
    categoryIds,
    primaryCategoryId: objectId,
    subCategory: Joi.string().allow('', null),
    tags: Joi.array().items(Joi.string()),
    // 3-Tier Pricing
    mrp: Joi.number().min(0).required(),
    retailPrice: Joi.number().min(0).required(),
    wholesalePrice: Joi.number().min(0).required(),
    minWholesaleQuantity: Joi.number().integer().min(1).default(10),
    negotiationEnabled: Joi.boolean().default(true),
    priceUnit: Joi.string().valid('piece', 'packet', 'box', 'bundle', 'coil', 'set').default('piece'),
    packSize: Joi.number().integer().min(1).default(1),
    minCustomerQuantity: Joi.number().integer().min(1).default(1),
    comingSoon: Joi.boolean().default(false),
    expectedLaunchDate: Joi.date().iso().allow(null, ''),
    autoLaunch: Joi.boolean().default(false),
    hidePriceWhileComingSoon: Joi.boolean().default(false),
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
    // Retired fields, still accepted from older admin pages.
    rating: Joi.number().min(0).max(5),
    purchaseCountMin: Joi.number().integer().min(0),
    purchaseCountMax: Joi.number().integer().min(0),
    company: Joi.string().allow('', null),
    videoUrl: Joi.string().allow('', null),
    shippingTerms: Joi.string().allow('', null),
  }).or('category', 'categoryIds'),

  updateProduct: Joi.object({
    name: Joi.string().max(200),
    description: Joi.string(),
    shortDescription: Joi.string().max(300),
    category: Joi.string(),
    categoryIds,
    primaryCategoryId: objectId.allow('', null),
    subCategory: Joi.string().allow('', null),
    tags: Joi.array().items(Joi.string()),
    // Live prices are changed only through the audited price-change endpoint.
    mrp: Joi.forbidden(),
    retailPrice: Joi.forbidden(),
    wholesalePrice: Joi.forbidden(),
    minWholesaleQuantity: Joi.number().integer().min(1),
    negotiationEnabled: Joi.boolean(),
    priceUnit: Joi.string().valid('piece', 'packet', 'box', 'bundle', 'coil', 'set'),
    packSize: Joi.number().integer().min(1),
    minCustomerQuantity: Joi.number().integer().min(1),
    comingSoon: Joi.boolean(),
    expectedLaunchDate: Joi.date().iso().allow(null, ''),
    autoLaunch: Joi.boolean(),
    hidePriceWhileComingSoon: Joi.boolean(),
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

  priceChange: Joi.object({
    retailPrice: Joi.number().min(0),
    wholesalePrice: Joi.number().min(0),
    mrp: Joi.number().min(0),
    priceChangeMode: Joi.string().valid('immediate', 'schedule_24h', 'schedule_48h', 'custom').required(),
    effectiveAt: Joi.when('priceChangeMode', {
      is: 'custom',
      then: Joi.string().isoDate().required(),
      otherwise: Joi.forbidden(),
    }),
  }).or('retailPrice', 'wholesalePrice', 'mrp'),

  updateAccountDeletionRequest: Joi.object({
    status: Joi.string().valid('in_review', 'rejected').required(),
    identityVerified: Joi.boolean().default(false),
    staffNote: Joi.string().trim().max(1000).allow('', null),
  }),

  completeAccountDeletionRequest: Joi.object({
    staffNote: Joi.string().trim().max(1000).allow('', null),
    // Website requests: the admin confirms they verified the account holder.
    identityVerified: Joi.boolean().default(false),
  }),

  createStaff: Joi.object({
    name: Joi.string().trim().max(100).required(),
    email: Joi.string().email().lowercase().required(),
    phone: Joi.string().trim().min(10).max(20).allow('', null),
    password: Joi.string().min(8).max(128).required(),
  }),

  updateStaff: Joi.object({
    name: Joi.string().trim().max(100),
    email: Joi.string().email().lowercase(),
    phone: Joi.string().trim().min(10).max(20).allow('', null),
    password: Joi.string().min(8).max(128),
    isActive: Joi.boolean(),
  }).or('name', 'email', 'phone', 'password', 'isActive'),

  staffList: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    search: Joi.string().trim().allow('', null),
  }),

  upgradeCustomer: Joi.object({
    action: Joi.string().valid('accept', 'reject').required(),
  }),

  counterRequirement: Joi.object({
    counters: Joi.array().items(Joi.object({
      negotiationId: objectId.required(),
      pricePerUnit: Joi.number().greater(0).required(),
    })).min(1).max(100).required(),
    message: Joi.string().max(500).allow('', null),
  }),

  respondRequirement: Joi.object({
    message: Joi.string().max(500).allow('', null),
  }),

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

  confirmOrder: Joi.object({
    deliveryCharge: Joi.number().min(0).max(10000000).required(),
    extraDiscount: Joi.number().min(0).max(10000000).default(0),
    extraDiscountType: Joi.string().valid('amount', 'percent').default('amount'),
  }),

  rejectOrder: Joi.object({
    reason: Joi.string().trim().min(1).max(500).required(),
  }),

  shipOrder: Joi.object({
    trackingNumber: Joi.string().required(),
    courierName: Joi.string().required(),
  }),

  rejectPayment: Joi.object({
    reason: Joi.string().required().max(500),
  }),

  priceChangeList: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    status: Joi.string().valid('scheduled', 'applied', 'superseded', 'cancelled'),
    q: Joi.string().trim().max(100).allow(''),
  }),

  markNotificationsRead: Joi.object({
    ids: Joi.array().items(objectId).max(200),
  }),

  webPushToken: Joi.object({
    fcmToken: Joi.string().max(4096).required(),
  }),

  setDiscount: Joi.object({
    customerDiscountPercent: Joi.number().min(0).max(99),
    wholesalerDiscountPercent: Joi.number().min(0).max(99),
  }).or('customerDiscountPercent', 'wholesalerDiscountPercent'),

  updateSettings: Joi.object({
    businessName: Joi.string().max(200),
    businessPhone: Joi.string(),
    businessEmail: Joi.string().email(),
    businessAddress: Joi.string().allow('').max(500),
    gstin: Joi.string().trim().uppercase().allow('')
      .pattern(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/)
      .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, like 22AAXFV7313A1Z8' }),
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
    mobileApp: Joi.object({
      android: platformUpdate,
      ios: platformUpdate,
    }),
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
