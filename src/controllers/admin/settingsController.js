const { Settings } = require('../../models');

// Leftover Razorpay fields are never sent (the gateway was removed).
const withoutRazorpay = (settings) => {
  const data = settings.toObject();
  delete data.razorpayKeyId;
  delete data.razorpayKeySecret;
  delete data.razorpayEnabled;
  return data;
};

exports.getSettings = async (req, res, next) => {
  try {
    const settings = await Settings.getSettings();

    res.json({
      success: true,
      data: withoutRazorpay(settings),
    });
  } catch (error) {
    next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    let settings = await Settings.findById('app_settings');

    if (!settings) {
      settings = new Settings({ _id: 'app_settings' });
    }

    const allowedFields = [
      'businessName',
      'businessPhone',
      'businessEmail',
      'businessAddress',
      'gstin',
      'upiId',
      'upiDisplayName',
      'minOrderAmount',
      'defaultBulkMinQuantity',
      'negotiationExpiryDays',
      'lowStockThreshold',
      'features',
      'mobileApp',
      'heroBanners',
      'promoBanners',
      'socialLinks',
      'bankName',
      'bankAccountNumber',
      'bankIfscCode',
      'bankAccountHolderName',
      'bankTransferEnabled',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        settings[field] = req.body[field];
      }
    }

    await settings.save();

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: withoutRazorpay(settings),
    });
  } catch (error) {
    next(error);
  }
};
