const crypto = require('crypto');

const generateOrderNumber = () => {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(1000, 9999);
  const timestamp = Date.now().toString().slice(-4);
  return `ORD-${year}-${timestamp}${random}`;
};

const generateNegotiationNumber = () => {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(1000, 9999);
  const timestamp = Date.now().toString().slice(-4);
  return `NGT-${year}-${timestamp}${random}`;
};

const generatePaymentNumber = () => {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(1000, 9999);
  const timestamp = Date.now().toString().slice(-4);
  return `PAY-${year}-${timestamp}${random}`;
};

const generateSKU = (category, name) => {
  const catCode = category.substring(0, 3).toUpperCase();
  const nameCode = name.substring(0, 3).toUpperCase();
  const random = crypto.randomInt(100, 999);
  return `${catCode}-${nameCode}-${random}`;
};

const paginate = (page = 1, limit = 20, maxLimit = 50) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(Math.max(1, parseInt(limit)), maxLimit);
  const skip = (pageNum - 1) * limitNum;

  return { page: pageNum, limit: limitNum, skip };
};

const formatPaginationResponse = (data, total, page, limit) => {
  const totalPages = Math.ceil(total / limit);
  
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};

const sanitizeUser = (user) => {
  const userObj = user.toObject ? user.toObject() : { ...user };
  delete userObj.passwordHash;
  delete userObj.__v;
  return userObj;
};

const formatPrice = (price) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(price);
};

module.exports = {
  generateOrderNumber,
  generateNegotiationNumber,
  generatePaymentNumber,
  generateSKU,
  paginate,
  formatPaginationResponse,
  sanitizeUser,
  formatPrice,
};
