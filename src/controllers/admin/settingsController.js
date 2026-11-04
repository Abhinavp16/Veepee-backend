const { Settings } = require('../../models');
const { forgetGuestPricing } = require('../../services/guestPricing');
const { normalizeQuickPicks } = require('../../utils/negotiationRules');
const { normalizeWhatsAppNumber } = require('../../services/oxonWhatsAppService');
const { BadRequestError } = require('../../utils/errors');
const { deleteRemovedBannerFiles } = require('../../services/catalogDeletion');

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

    // A banner taken off (or its picture or video changed) has its old files
    // removed from storage once saved.
    const bannersBefore = [...(settings.heroBanners || []), ...(settings.promoBanners || [])]
      .map((banner) => ({ imageUrl: banner.imageUrl, videoUrl: banner.videoUrl }));

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
      'negotiationQuickPicks',
      'whatsappAlerts',
      'negotiationMaxDiscountPercent',
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
      if (req.body[field] === undefined) continue;
      if (field === 'features') {
        // Merge, so saving one switch never resets the others.
        const current = settings.features?.toObject?.() || settings.features || {};
        settings.features = { ...current, ...req.body.features };
      } else if (field === 'whatsappAlerts') {
        // Merge; the number is stored as 91XXXXXXXXXX.
        const current = settings.whatsappAlerts?.toObject?.() || settings.whatsappAlerts || {};
        const next = { ...current, ...req.body.whatsappAlerts };
        if (req.body.whatsappAlerts.number !== undefined) {
          next.number = normalizeWhatsAppNumber(req.body.whatsappAlerts.number);
          if (!next.number) throw new BadRequestError('Enter a valid WhatsApp number', 'INVALID_WHATSAPP_NUMBER');
        }
        settings.whatsappAlerts = next;
      } else if (field === 'negotiationQuickPicks') {
        // Distinct, largest first, at most four.
        settings.negotiationQuickPicks = normalizeQuickPicks(req.body.negotiationQuickPicks);
      } else {
        settings[field] = req.body[field];
      }
    }

    await settings.save();
    forgetGuestPricing();
    await deleteRemovedBannerFiles(bannersBefore, [...(settings.heroBanners || []), ...(settings.promoBanners || [])]);

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: withoutRazorpay(settings),
    });
  } catch (error) {
    next(error);
  }
};
