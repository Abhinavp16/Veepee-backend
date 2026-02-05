module.exports = {
  USER_ROLES: {
    BUYER: 'buyer',
    WHOLESALER: 'wholesaler',
    ADMIN: 'admin',
  },

  AUTH_PROVIDERS: {
    EMAIL: 'email',
    GOOGLE: 'google',
  },

  PRODUCT_STATUS: {
    ACTIVE: 'active',
    DRAFT: 'draft',
    ARCHIVED: 'archived',
  },

  ORDER_STATUS: {
    PENDING_PAYMENT: 'pending_payment',
    PAYMENT_UPLOADED: 'payment_uploaded',
    PAYMENT_VERIFIED: 'payment_verified',
    PROCESSING: 'processing',
    SHIPPED: 'shipped',
    DELIVERED: 'delivered',
    CANCELLED: 'cancelled',
  },

  ORDER_TYPES: {
    RETAIL: 'retail',
    WHOLESALE: 'wholesale',
  },

  NEGOTIATION_STATUS: {
    PENDING: 'pending',
    COUNTERED: 'countered',
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
    EXPIRED: 'expired',
    CONVERTED: 'converted',
  },

  NEGOTIATION_ACTIONS: {
    REQUESTED: 'requested',
    COUNTERED: 'countered',
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
  },

  PAYMENT_STATUS: {
    PENDING: 'pending',
    VERIFIED: 'verified',
    REJECTED: 'rejected',
  },

  ANALYTICS_EVENTS: {
    VIEW: 'view',
    CART_ADD: 'cart_add',
    WISHLIST_ADD: 'wishlist_add',
    NEGOTIATION_START: 'negotiation_start',
    PURCHASE: 'purchase',
  },

  ANALYTICS_SOURCES: {
    HOME: 'home',
    CATEGORY: 'category',
    SEARCH: 'search',
    FEATURED: 'featured',
    DIRECT: 'direct',
  },

  NOTIFICATION_TYPES: {
    NEGOTIATION_REQUESTED: 'negotiation_requested',
    NEGOTIATION_COUNTERED: 'negotiation_countered',
    NEGOTIATION_ACCEPTED: 'negotiation_accepted',
    NEGOTIATION_REJECTED: 'negotiation_rejected',
    PAYMENT_VERIFIED: 'payment_verified',
    PAYMENT_REJECTED: 'payment_rejected',
    ORDER_SHIPPED: 'order_shipped',
    ORDER_DELIVERED: 'order_delivered',
    LOW_STOCK_ALERT: 'low_stock_alert',
    HIGH_DEMAND_ALERT: 'high_demand_alert',
  },

  DEFAULT_SETTINGS: {
    NEGOTIATION_EXPIRY_DAYS: 7,
    LOW_STOCK_THRESHOLD: 5,
    MIN_BULK_QUANTITY: 10,
    HIGH_DEMAND_VIEW_THRESHOLD: 50,
    HIGH_DEMAND_NEGOTIATION_THRESHOLD: 3,
  },
};
