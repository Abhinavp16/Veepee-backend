const { Settings } = require('../../models');

exports.getSettings = async (req, res, next) => {
  try {
    const settings = await Settings.getSettings();

    res.json({
      success: true,
      data: settings,
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
      'upiId',
      'upiDisplayName',
      'minOrderAmount',
      'defaultBulkMinQuantity',
      'negotiationExpiryDays',
      'lowStockThreshold',
      'features',
      'heroBanners',
      'promoBanners',
      'socialLinks',
      'razorpayKeyId',
      'razorpayKeySecret',
      'razorpayEnabled',
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

    console.log('[Settings Update] razorpayEnabled:', req.body.razorpayEnabled, '| bankTransferEnabled:', req.body.bankTransferEnabled);
    console.log('[Settings Update] razorpayKeyId present:', !!req.body.razorpayKeyId);

    await settings.save();

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: settings,
    });
  } catch (error) {
    next(error);
  }
};
