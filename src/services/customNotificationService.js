const mongoose = require('mongoose');
const {
  User, Cart, DeviceToken, GuestDevice, Notification, NotificationCampaign, Product, Category, Sale, Offer,
} = require('../models');
const notificationService = require('./notificationService');
const { saleStatus } = require('./saleService');
const { BadRequestError, ConflictError } = require('../utils/errors');
const { USER_ROLES, PRODUCT_STATUS } = require('../utils/constants');
const { PAGE_ROLES, GUEST_PAGES, GUEST_ONLY_PAGES } = require('../utils/customNotificationDefaults');

// Admin "Custom notification" (Customers page): who gets it, what tapping it
// opens, an optional coupon, each person's name and language. Every
// recipient gets it in their in-app inbox, and a push on every phone they're
// signed in on. Each send is kept for the History tab (NotificationCampaign).

const customerRoles = [USER_ROLES.BUYER, USER_ROLES.WHOLESALER];
const ROLE_WORDS = { [USER_ROLES.BUYER]: 'customers', [USER_ROLES.WHOLESALER]: 'wholesalers' };
const PAGE_NAMES = { wholesaler: 'Apply for Wholesaler', negotiations: 'Ask your price' };
const INSERT_BATCH = 1000;

// A notification's picture is the linked product's, category's or sale's own
// picture, or one uploaded for notifications to OXON's storage
// (https://storage.googleapis.com/<OXON's bucket>/notifications/...), never
// anything else (another bucket, payment proofs, other websites).
function uploadedNotificationImage(url) {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucket) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:'
    && parsed.hostname === 'storage.googleapis.com'
    && parsed.pathname.startsWith(`/${bucket}/notifications/`)
    && !parsed.pathname.includes('/../')
    && !parsed.search && !parsed.hash;
}

function checkNotificationImage(imageUrl, linkedImage) {
  const url = String(imageUrl || '').trim();
  if (!url || url === linkedImage) return url;
  if (!uploadedNotificationImage(url)) {
    throw new BadRequestError('Upload the picture here, or use the product, category or sale picture', 'INVALID_IMAGE');
  }
  return url;
}

// Sales for customers, wholesalers or both: a sale only opens in the app for
// its audience (saleController's saleIsFor), so the other group can't get it.
const SALE_AUDIENCE_ROLES = { customers: USER_ROLES.BUYER, wholesalers: USER_ROLES.WHOLESALER, both: null };

/**
 * Where tapping it goes, as notification data (all strings), the linked
 * item's picture, a summary for the history, and the one account type it is
 * for (role, null for everyone). A product link carries no `type`, so app
 * versions from before links still open the product; a sale link has type
 * 'sale', which older apps already open as /sale/:id.
 */
async function notificationLink(link) {
  if (!link) return { data: { type: 'custom_admin_notification' }, image: '', summary: null, role: null };
  if (link.type === 'page') {
    return {
      data: { link: 'page', page: link.page },
      image: '',
      summary: { type: 'page', page: link.page },
      role: PAGE_ROLES[link.page] || null,
      roleName: PAGE_NAMES[link.page] || link.page,
    };
  }
  if (!mongoose.Types.ObjectId.isValid(link.id)) {
    throw new BadRequestError('The linked item was not found', 'LINK_NOT_FOUND');
  }
  if (link.type === 'product') {
    const product = await Product.findOne({ _id: link.id, status: PRODUCT_STATUS.ACTIVE })
      .select('name images').lean();
    if (!product) {
      throw new BadRequestError('That product is not on sale (archived, draft or deleted). Pick another.', 'LINK_NOT_FOUND');
    }
    const images = product.images || [];
    const photo = (images.find((image) => image.isPrimary) || images[0])?.url || '';
    return {
      data: { link: 'product', productId: String(product._id) },
      image: photo,
      summary: { type: 'product', id: String(product._id), name: product.name },
      role: null,
    };
  }
  if (link.type === 'sale') {
    const sale = await Sale.findById(link.id).select('name status audience startsAt endsAt endedAt heroImageUrl').lean();
    if (!sale) throw new BadRequestError('That sale was not found', 'LINK_NOT_FOUND');
    const status = saleStatus(sale);
    if (status === 'ended') throw new BadRequestError(`"${sale.name}" has ended. Pick a live or upcoming sale.`, 'SALE_ENDED');
    if (status === 'draft') throw new BadRequestError(`"${sale.name}" is a draft. Publish it first, or pick another sale.`, 'SALE_NOT_PUBLISHED');
    return {
      data: { type: 'sale', link: 'sale', saleId: String(sale._id) },
      image: sale.heroImageUrl || '',
      summary: { type: 'sale', id: String(sale._id), name: sale.name },
      role: SALE_AUDIENCE_ROLES[sale.audience] ?? null,
      roleName: sale.name,
    };
  }
  const category = await Category.findOne({ _id: link.id, isActive: { $ne: false } })
    .select('name slug image').lean();
  if (!category) throw new BadRequestError('That category was not found', 'LINK_NOT_FOUND');
  return {
    data: {
      type: 'custom_admin_notification',
      link: 'category',
      categorySlug: category.slug,
      categoryName: category.name,
    },
    image: category.image?.url || '',
    summary: { type: 'category', id: String(category._id), name: category.name },
    role: null,
  };
}

/** The account type a link is for, without the other checks (for counting). */
async function linkRole(link) {
  if (!link) return null;
  if (link.type === 'page') return PAGE_ROLES[link.page] || null;
  if (link.type === 'sale' && mongoose.Types.ObjectId.isValid(link.id)) {
    const sale = await Sale.findById(link.id).select('audience').lean();
    return SALE_AUDIENCE_ROLES[sale?.audience] ?? null;
  }
  return null;
}

/**
 * The one account type a group audience has ('buyer' or 'wholesaler'), or
 * null when it mixes both (or is a list of chosen people).
 */
function audienceRole({ audience, segment }) {
  // Phones that aren't signed in become customers when they sign up.
  if (audience === 'buyers' || audience === 'guests') return USER_ROLES.BUYER;
  if (audience === 'wholesalers') return USER_ROLES.WHOLESALER;
  if (audience === 'cart' || audience === 'saved') {
    if (segment === 'buyers') return USER_ROLES.BUYER;
    if (segment === 'wholesalers') return USER_ROLES.WHOLESALER;
  }
  return null;
}

/**
 * Who gets it, as a User query: the chosen people; every customer or
 * wholesaler; everyone with something in their cart; or everyone who saved a
 * product. Active, not deleted customer and wholesaler accounts only.
 */
async function recipientQuery({ audience = 'selected', userIds = [], segment = 'all', productId }) {
  const query = { isActive: { $ne: false }, deletedAt: null, role: { $in: customerRoles } };
  if (audience === 'buyers') query.role = USER_ROLES.BUYER;
  else if (audience === 'wholesalers') query.role = USER_ROLES.WHOLESALER;
  else if (audience === 'cart' || audience === 'saved') {
    query.role = audienceRole({ audience, segment }) || { $in: customerRoles };
    if (audience === 'cart') {
      query._id = { $in: await Cart.distinct('userId', { 'items.0': { $exists: true } }) };
    } else {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new BadRequestError('Pick the product people saved', 'PRODUCT_REQUIRED');
      }
      query.wishlist = new mongoose.Types.ObjectId(String(productId));
    }
  } else {
    query._id = {
      $in: [...new Set(userIds.map(String))]
        .filter((id) => /^[0-9a-fA-F]{24}$/.test(id))
        .map((id) => new mongoose.Types.ObjectId(id)),
    };
  }
  return query;
}

async function notificationRecipients(body) {
  return User.find(await recipientQuery(body)).select('_id role name preferredLanguage').lean();
}

/**
 * A link for one account type ("Apply for Wholesaler" for customers, "Ask
 * your price" for wholesalers, a customers-only or wholesalers-only sale): a
 * group of the wrong kind is refused; from chosen people, those of the other
 * kind are left out (and counted).
 */
function applyRoleRule(linkInfo, body, users) {
  const needed = linkInfo?.role;
  if (!needed) return { users, skipped: 0 };
  const what = linkInfo.summary?.type === 'sale' ? `The sale "${linkInfo.roleName}"` : `"${linkInfo.roleName}"`;
  const code = linkInfo.summary?.type === 'sale' ? 'SALE_NOT_FOR_AUDIENCE' : 'PAGE_NOT_FOR_AUDIENCE';
  if (body.audience !== 'selected') {
    if (audienceRole(body) !== needed) {
      const fix = needed === USER_ROLES.BUYER
        ? 'Send it to All customers, or choose Customers in the filter.'
        : 'Send it to All wholesalers, or choose Wholesalers in the filter.';
      throw new BadRequestError(`${what} is only for ${ROLE_WORDS[needed]}. ${fix}`, code);
    }
    return { users, skipped: 0 };
  }
  const kept = users.filter((user) => user.role === needed);
  if (kept.length === 0 && users.length > 0) {
    throw new BadRequestError(
      `${what} is only for ${ROLE_WORDS[needed]}, and none of the chosen people are ${ROLE_WORDS[needed]}.`,
      code
    );
  }
  return { users: kept, skipped: users.length - kept.length };
}

/**
 * An active coupon (on, started, not ended, uses left) that every recipient
 * can use: a customers-only coupon can't go to wholesalers and the other way
 * round.
 */
async function checkCoupon(code, body, users) {
  if (!code) return null;
  const now = new Date();
  const offer = await Offer.findOne({
    code,
    isActive: true,
    startDate: { $lte: now },
    $or: [{ endDate: null }, { endDate: { $exists: false } }, { endDate: { $gte: now } }],
  }).select('code targetGroup usageLimit usageCount').lean();
  if (!offer) {
    throw new BadRequestError(`There is no active coupon with the code ${code}. Check it in Offers.`, 'COUPON_NOT_FOUND');
  }
  if (offer.usageLimit > 0 && offer.usageCount >= offer.usageLimit) {
    throw new BadRequestError(`Coupon ${code} has been fully used.`, 'COUPON_LIMIT_REACHED');
  }
  const group = offer.targetGroup;
  if (group && group !== 'all') {
    const words = ROLE_WORDS[group] || group;
    if (body.audience !== 'selected') {
      if (audienceRole(body) !== group) {
        throw new BadRequestError(`Coupon ${code} is only for ${words}. Send it to ${words} only, or pick another coupon.`, 'COUPON_NOT_FOR_AUDIENCE');
      }
    } else {
      const others = users.filter((user) => user.role !== group).length;
      if (others > 0) {
        throw new BadRequestError(
          `Coupon ${code} is only for ${words}, but ${others} of the chosen ${others === 1 ? 'person is' : 'people are'} not. Pick another coupon or change who gets it.`,
          'COUPON_NOT_FOR_AUDIENCE'
        );
      }
    }
  }
  return offer;
}

// "{name}" in the text becomes each person's first name.
const NAME_PATTERN = /\{\s*name\s*\}/gi;
const hasNamePlaceholder = (...texts) => texts.some((text) => text && /\{\s*name\s*\}/i.test(text));
// Titles before a name ("Dr. Ramesh Kumar" → "Ramesh").
const NAME_PREFIX = /^(dr|mr|mrs|ms|miss|shri|shree|sri|smt|kumari|m\/s)\.?$/i;
function firstName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && NAME_PREFIX.test(words[0])) words.shift();
  const first = words[0] || '';
  return NAME_PREFIX.test(first) ? '' : first;
}
// A replacer function, so "$&" or "$1" in a name is kept as typed.
const fillName = (text, name, fallback) => String(text || '').replace(NAME_PATTERN, () => name || fallback);

/** The title and body one person sees, in their language. */
function messageFor(user, texts) {
  const hindi = texts.hasHindi && user.preferredLanguage === 'hi';
  const name = firstName(user.name);
  const fallback = hindi ? 'जी' : 'there';
  const title = fillName(hindi ? texts.titleHi : texts.title, name, fallback);
  let body = fillName(hindi ? texts.bodyHi : texts.body, name, fallback);
  if (texts.couponCode) {
    body += hindi ? ` कोड ${texts.couponCode} इस्तेमाल करें।` : ` Use code ${texts.couponCode}.`;
  }
  return { title, body };
}

/** Both Hindi fields, or neither. */
function hindiTexts(body) {
  const titleHi = String(body.titleHi || '').trim();
  const bodyHi = String(body.bodyHi || '').trim();
  if (Boolean(titleHi) !== Boolean(bodyHi)) {
    throw new BadRequestError('Fill in both the Hindi title and the Hindi message, or leave both empty', 'HINDI_INCOMPLETE');
  }
  return { titleHi, bodyHi };
}

const noRecipientsError = (body) => new BadRequestError(
  body.audience && body.audience !== 'selected'
    ? 'Nobody in that group can receive notifications yet'
    : 'None of the selected people can receive notifications',
  'NO_RECIPIENTS'
);

// ---- Phones that aren't signed in ("guests") ------------------------------

/**
 * What a notification to phones that aren't signed in may open: pages that
 * work without an account, a product, a category or a sale for customers.
 * Create account ('signup') is for those phones only.
 */
function checkGuestLink(body) {
  const link = body.link;
  const isGuests = body.audience === 'guests';
  if (link?.type !== 'page') return;
  if (isGuests && !GUEST_PAGES.includes(link.page)) {
    throw new BadRequestError(
      'That page needs an account. For phones that aren\'t signed in, pick Create account, a product, a category, a sale, Hot deals, Popular, Coming soon or Coupons.',
      'PAGE_NEEDS_ACCOUNT'
    );
  }
  if (!isGuests && GUEST_ONLY_PAGES.includes(link.page)) {
    throw new BadRequestError('Create account is only for phones that aren\'t signed in', 'PAGE_NOT_FOR_AUDIENCE');
  }
}

/** The not-signed-in phones, optionally only those that joined lately. */
function guestQuery({ installedWithinDays }) {
  const query = {};
  const days = Number(installedWithinDays);
  if (days > 0) query.createdAt = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  return query;
}

// A phone is left out when someone is signed in on it (an active account
// token): the not-signed-in row may be older than the sign-in.
const notSignedInStages = [
  {
    $lookup: {
      from: DeviceToken.collection.name,
      localField: 'fcmToken',
      foreignField: 'fcmToken',
      pipeline: [{ $match: { isActive: true } }, { $limit: 1 }, { $project: { _id: 1 } }],
      as: 'signedIn',
    },
  },
  { $match: { 'signedIn.0': { $exists: false } } },
];

async function countGuests(body) {
  const [row] = await GuestDevice.aggregate([
    { $match: guestQuery(body) },
    ...notSignedInStages,
    { $group: { _id: null, phones: { $sum: 1 }, hindi: { $sum: { $cond: [{ $eq: ['$language', 'hi'] }, 1, 0] } } } },
  ]);
  const phones = row?.phones || 0;
  return { people: phones, phones, hindi: row?.hindi || 0, skipped: 0 };
}

async function guestRecipients(body) {
  return GuestDevice.aggregate([
    { $match: guestQuery(body) },
    ...notSignedInStages,
    { $project: { _id: 0, fcmToken: 1, language: 1 } },
  ]);
}

/**
 * POST /admin/customers/notifications/count: people and phones it would
 * reach. Counted in the database (no list of people is loaded).
 */
async function countRecipients(body) {
  if (body.audience === 'guests') return countGuests(body);
  const query = await recipientQuery(body);
  // Only the chosen-people filter applies here; a group of the wrong kind is
  // refused when sending (the admin form doesn't offer it).
  const needed = body.audience === 'selected' ? await linkRole(body.link) : null;
  const all = await User.countDocuments(query);
  const kept = needed ? { ...query, role: needed } : query;
  const people = needed ? await User.countDocuments(kept) : all;
  let phones = 0;
  if (people > 0) {
    const [row] = await DeviceToken.aggregate([
      { $match: { isActive: true } },
      {
        $lookup: {
          from: User.collection.name,
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $match: kept }, { $project: { _id: 1 } }],
          as: 'owner',
        },
      },
      { $match: { 'owner.0': { $exists: true } } },
      { $group: { _id: '$fcmToken' } },
      { $count: 'phones' },
    ]);
    phones = row?.phones || 0;
  }
  return { people, phones, skipped: all - people };
}

const ALREADY_SENT = 'This notification was already sent. Check History before sending it again.';

/**
 * Sends it, saves everyone's inbox copy and the history row. With a sendId
 * (from the admin form), the history row is written first and a repeat of
 * the same sendId is refused (409), so a retry never sends twice.
 */
async function sendCustomNotification(body, sender) {
  const { title, body: text } = body;
  const sendId = body.sendId ? String(body.sendId) : undefined;
  if (sendId && await NotificationCampaign.exists({ sendId })) {
    throw new ConflictError(ALREADY_SENT, 'ALREADY_SENT');
  }
  const { titleHi, bodyHi } = hindiTexts(body);
  const couponCode = String(body.couponCode || '').trim().toUpperCase();
  checkGuestLink(body);
  const linkInfo = await notificationLink(body.link);
  const { data: linkData, image: linkedImage, summary } = linkInfo;
  const imageUrl = checkNotificationImage(body.imageUrl, linkedImage);

  if (body.audience === 'guests') {
    return sendToGuests(body, sender, {
      sendId, title, text, titleHi, bodyHi, couponCode, linkInfo, imageUrl,
    });
  }

  let product = null;
  if (body.audience === 'saved') {
    product = await Product.findById(body.productId).select('name').lean();
    if (!product) throw new BadRequestError('That product was not found', 'PRODUCT_NOT_FOUND');
  }

  // A group of the wrong kind is refused before looking anyone up.
  const isGroup = Boolean(body.audience) && body.audience !== 'selected';
  if (isGroup) {
    applyRoleRule(linkInfo, body, []);
    await checkCoupon(couponCode, body, []);
  }
  const found = await notificationRecipients(body);
  if (found.length === 0) throw noRecipientsError(body);
  const { users, skipped } = applyRoleRule(linkInfo, body, found);
  if (!isGroup) await checkCoupon(couponCode, body, users);

  // The history row first: it holds the sendId, so a second request with
  // the same id stops here.
  let campaign;
  try {
    campaign = await NotificationCampaign.create({
      title,
      body: text,
      titleHi,
      bodyHi,
      audience: body.audience || 'selected',
      segment: body.audience === 'cart' || body.audience === 'saved' ? body.segment || 'all' : null,
      productId: product?._id || null,
      productName: product?.name || '',
      link: summary,
      couponCode,
      imageUrl,
      sentBy: { id: sender?._id || null, name: sender?.name || '' },
      recipients: users.length,
      skipped,
      sendId,
      status: 'sending',
    });
  } catch (error) {
    if (error?.code === 11000) throw new ConflictError(ALREADY_SENT, 'ALREADY_SENT');
    throw error;
  }

  const texts = { title, body: text, titleHi, bodyHi, hasHindi: Boolean(titleHi), couponCode };
  // Everyone gets the same words unless a {name} or the Hindi text makes
  // them differ; then each phone gets its own message.
  const personal = texts.hasHindi || hasNamePlaceholder(title, text, titleHi, bodyHi);

  // The inbox copy keeps the picture and coupon too, for the app to show.
  const data = {
    ...linkData,
    ...(couponCode && { couponCode }),
    ...(imageUrl && { imageUrl }),
  };
  const messages = new Map(users.map((user) => [String(user._id), messageFor(user, texts)]));
  const tokenOwner = new Map();
  try {
    const rows = users.map((user) => ({ userId: user._id, ...messages.get(String(user._id)), type: 'general', data }));
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      await Notification.insertMany(rows.slice(start, start + INSERT_BATCH), { ordered: false });
    }
    const tokens = await DeviceToken.find({ userId: { $in: users.map((user) => user._id) }, isActive: true })
      .select('userId fcmToken').lean();
    // A phone shared by two accounts gets one push.
    for (const token of tokens) {
      if (!tokenOwner.has(token.fcmToken)) tokenOwner.set(token.fcmToken, String(token.userId));
    }
  } catch (error) {
    await NotificationCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'failed', pushError: error.message } })
      .catch(() => {});
    throw error;
  }
  const phones = tokenOwner.size;

  let delivered = 0;
  let failed = 0;
  let pushError = '';
  let pushConfigured = Boolean(notificationService.getMessagingInstance());
  if (pushConfigured && phones > 0) {
    try {
      let result;
      if (personal) {
        result = await notificationService.sendEachToDevices([...tokenOwner].map(([token, userId]) => ({
          token,
          notification: { ...messages.get(userId), ...(imageUrl && { imageUrl }) },
          data,
        })));
      } else {
        const same = messageFor({}, texts);
        result = await notificationService.sendToMultipleDevices(
          [...tokenOwner.keys()],
          { ...same, ...(imageUrl && { imageUrl }) },
          data
        );
      }
      if (result === null) {
        pushConfigured = false;
      } else {
        delivered = result.successCount || 0;
        failed = result.failureCount || 0;
        if (result.batchErrors) pushError = 'Firebase did not accept some of the pushes';
      }
    } catch (error) {
      // Saved in every inbox already; the pushes that didn't go count as failed.
      console.error('Custom notification push failed:', error.message);
      failed = phones - delivered;
      pushError = error.message || 'Push failed';
    }
  }

  await NotificationCampaign.updateOne(
    { _id: campaign._id },
    { $set: { status: 'sent', phones, delivered, failed, pushConfigured, pushError } }
  ).catch((error) => console.error('Could not update the notification history:', error.message));

  const people = `${users.length} ${users.length === 1 ? 'person' : 'people'}`;
  let pushText;
  if (!pushConfigured) pushText = 'push not sent: Firebase is not set up on the server';
  else if (phones === 0) pushText = 'nobody has the app signed in on a phone, so no push was sent';
  else if (pushError) pushText = `push delivered to ${delivered} of ${phones} phones; the rest failed (${pushError}). Don't send it again: everyone already has it in the app`;
  else pushText = `push delivered to ${delivered} of ${phones} phones`;
  const skippedText = skipped > 0
    ? ` ${skipped} chosen ${skipped === 1 ? 'person was' : 'people were'} left out: what it opens isn't for their account type.`
    : '';

  return {
    message: `Saved for ${people} · ${pushText}.${skippedText}`,
    data: { saved: users.length, phones, delivered, failed, pushConfigured, skipped, campaignId: String(campaign._id) },
  };
}

/**
 * A custom notification to phones that aren't signed in: a push only (they
 * have no in-app inbox), in each phone's language, with {name} as "there".
 */
async function sendToGuests(body, sender, {
  sendId, title, text, titleHi, bodyHi, couponCode, linkInfo, imageUrl,
}) {
  applyRoleRule(linkInfo, body, []);
  await checkCoupon(couponCode, body, []);
  const devices = await guestRecipients(body);
  if (devices.length === 0) {
    throw new BadRequestError(
      'No phone that isn\'t signed in can get notifications yet. Phones join once they have the new app version and allow notifications.',
      'NO_RECIPIENTS'
    );
  }

  let campaign;
  try {
    campaign = await NotificationCampaign.create({
      title,
      body: text,
      titleHi,
      bodyHi,
      audience: 'guests',
      installedWithinDays: Number(body.installedWithinDays) || null,
      link: linkInfo.summary,
      couponCode,
      imageUrl,
      sentBy: { id: sender?._id || null, name: sender?.name || '' },
      recipients: devices.length,
      sendId,
      status: 'sending',
    });
  } catch (error) {
    if (error?.code === 11000) throw new ConflictError(ALREADY_SENT, 'ALREADY_SENT');
    throw error;
  }

  const texts = { title, body: text, titleHi, bodyHi, hasHindi: Boolean(titleHi), couponCode };
  const data = {
    ...linkInfo.data,
    ...(couponCode && { couponCode }),
    ...(imageUrl && { imageUrl }),
  };
  const english = messageFor({ preferredLanguage: 'en' }, texts);
  const hindi = messageFor({ preferredLanguage: 'hi' }, texts);
  const phones = devices.length;

  let delivered = 0;
  let failed = 0;
  let pushError = '';
  let pushConfigured = Boolean(notificationService.getMessagingInstance());
  if (pushConfigured) {
    try {
      const result = texts.hasHindi
        ? await notificationService.sendEachToDevices(devices.map((device) => ({
          token: device.fcmToken,
          notification: { ...(device.language === 'hi' ? hindi : english), ...(imageUrl && { imageUrl }) },
          data,
        })))
        : await notificationService.sendToMultipleDevices(
          devices.map((device) => device.fcmToken),
          { ...english, ...(imageUrl && { imageUrl }) },
          data
        );
      if (result === null) {
        pushConfigured = false;
      } else {
        delivered = result.successCount || 0;
        failed = result.failureCount || 0;
        if (result.batchErrors) pushError = 'Firebase did not accept some of the pushes';
      }
    } catch (error) {
      console.error('Custom notification push (not signed in) failed:', error.message);
      failed = phones - delivered;
      pushError = error.message || 'Push failed';
    }
  }

  await NotificationCampaign.updateOne(
    { _id: campaign._id },
    { $set: { status: 'sent', phones, delivered, failed, pushConfigured, pushError } }
  ).catch((error) => console.error('Could not update the notification history:', error.message));

  const phoneWords = `${phones} ${phones === 1 ? 'phone' : 'phones'} that ${phones === 1 ? 'isn\'t' : 'aren\'t'} signed in`;
  let message;
  if (!pushConfigured) message = `Not sent to ${phoneWords}: Firebase is not set up on the server.`;
  else if (pushError) message = `Delivered to ${delivered} of ${phoneWords}; the rest failed (${pushError}).`;
  else message = `Delivered to ${delivered} of ${phoneWords}.`;
  return {
    message,
    data: { saved: 0, phones, delivered, failed, pushConfigured, skipped: 0, campaignId: String(campaign._id) },
  };
}

module.exports = {
  sendCustomNotification,
  countRecipients,
  notificationRecipients,
  notificationLink,
  checkNotificationImage,
  uploadedNotificationImage,
  messageFor,
  firstName,
};
