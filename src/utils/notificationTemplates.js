// Push/in-app notification text in English and Hindi. Keep the `{name}`
// placeholders identical in both languages.
const TEMPLATES = {
  orderConfirmed: {
    en: { title: 'Order Confirmed!', body: 'Your order has been confirmed and is being processed.' },
    hi: { title: 'ऑर्डर कन्फर्म हो गया!', body: 'आपका ऑर्डर कन्फर्म हो गया है और तैयार किया जा रहा है।' },
  },
  orderShipped: {
    en: { title: 'Order Shipped!', body: 'Your order is on its way!' },
    hi: { title: 'ऑर्डर भेज दिया गया!', body: 'आपका ऑर्डर रास्ते में है!' },
  },
  orderDelivered: {
    en: { title: 'Order Delivered!', body: 'Your order has been delivered. Enjoy!' },
    hi: { title: 'ऑर्डर डिलीवर हो गया!', body: 'आपका ऑर्डर डिलीवर हो गया है।' },
  },
  orderCancelled: {
    en: { title: 'Order Cancelled', body: 'Your order has been cancelled.' },
    hi: { title: 'ऑर्डर रद्द हुआ', body: 'आपका ऑर्डर रद्द कर दिया गया है।' },
  },
  orderUpdated: {
    en: { title: 'Order Update', body: 'Your order status has been updated to {status}' },
    hi: { title: 'ऑर्डर अपडेट', body: 'आपके ऑर्डर की स्थिति बदलकर {status} हो गई है' },
  },
  priceChanged: {
    en: { title: 'Price Updated', body: '{productName} is now ₹{retailPrice}.' },
    hi: { title: 'कीमत बदली', body: '{productName} अब ₹{retailPrice} का है।' },
  },
  priceChangedGeneric: {
    en: { title: 'Price Updated', body: '{productName} has an updated price.' },
    hi: { title: 'कीमत बदली', body: '{productName} की कीमत अपडेट हुई है।' },
  },
  priceChangeScheduled: {
    en: { title: 'Price changing soon', body: '{productName} will be ₹{newPrice} from {effectiveDate}.' },
    hi: { title: 'कीमत जल्द बदलेगी', body: '{productName} की कीमत {effectiveDate} से ₹{newPrice} होगी।' },
  },
  priceChangeReminder: {
    en: { title: 'Price changes tomorrow', body: '{productName} goes to ₹{newPrice} on {effectiveDate}.' },
    hi: { title: 'कल कीमत बदलेगी', body: '{productName} की कीमत {effectiveDate} को ₹{newPrice} हो जाएगी।' },
  },
  paymentVerified: {
    en: {
      title: 'Payment Verified!',
      body: "Your payment for order {orderNumber} has been verified. We're processing your order now.",
    },
    hi: {
      title: 'पेमेंट सत्यापित हुआ!',
      body: 'ऑर्डर {orderNumber} का आपका पेमेंट सत्यापित हो गया है। हम आपका ऑर्डर तैयार कर रहे हैं।',
    },
  },
  paymentRejected: {
    en: {
      title: 'Payment Declined',
      body: 'Your payment for order {orderNumber} was declined. Please re-upload.',
    },
    hi: {
      title: 'पेमेंट अस्वीकृत',
      body: 'ऑर्डर {orderNumber} का आपका पेमेंट अस्वीकृत हो गया। कृपया दोबारा अपलोड करें।',
    },
  },
  paymentRejectedWithReason: {
    en: {
      title: 'Payment Declined',
      body: 'Your payment for order {orderNumber} was declined: {reason}',
    },
    hi: {
      title: 'पेमेंट अस्वीकृत',
      body: 'ऑर्डर {orderNumber} का आपका पेमेंट अस्वीकृत हुआ: {reason}',
    },
  },
  productLaunched: {
    en: { title: 'Now available!', body: '{productName} is now available on OXON.' },
    hi: { title: 'अब उपलब्ध!', body: '{productName} अब OXON पर उपलब्ध है।' },
  },
  requirementCountered: {
    en: { title: 'Counter offer on your requirement', body: 'The dealer sent new prices for {requirementNumber} ({count} products). Review and respond.' },
    hi: { title: 'आपकी आवश्यकता पर नया प्रस्ताव', body: 'डीलर ने {requirementNumber} ({count} उत्पाद) के लिए नई कीमतें भेजी हैं। देखें और जवाब दें।' },
  },
  requirementAccepted: {
    en: { title: 'Requirement accepted!', body: 'Your requirement {requirementNumber} was accepted. You can pay for all {count} products together now.' },
    hi: { title: 'आवश्यकता स्वीकार हुई!', body: 'आपकी आवश्यकता {requirementNumber} स्वीकार हो गई है। अब सभी {count} उत्पादों का भुगतान एक साथ करें।' },
  },
  requirementDeclined: {
    en: { title: 'Requirement declined', body: 'Your requirement {requirementNumber} was declined.' },
    hi: { title: 'आवश्यकता अस्वीकृत', body: 'आपकी आवश्यकता {requirementNumber} अस्वीकार कर दी गई।' },
  },
  negotiationUpdate: {
    en: { title: 'Negotiation Update', body: '{message}' },
    hi: { title: 'मोलभाव अपडेट', body: '{message}' },
  },
};

const SUPPORTED_LANGUAGES = ['en', 'hi'];

const normalizeLanguage = (language) =>
  SUPPORTED_LANGUAGES.includes(language) ? language : 'en';

/**
 * Renders a template in the given language. Unknown placeholders are left
 * blank rather than printing `{name}` to a customer.
 */
const renderTemplate = (key, language, params = {}) => {
  const entry = TEMPLATES[key];
  if (!entry) throw new Error(`Unknown notification template: ${key}`);
  const text = entry[normalizeLanguage(language)];
  const fill = (value) =>
    value.replace(/\{(\w+)\}/g, (_, name) =>
      params[name] === undefined || params[name] === null ? '' : String(params[name])
    );
  return { title: fill(text.title), body: fill(text.body) };
};

module.exports = { TEMPLATES, SUPPORTED_LANGUAGES, normalizeLanguage, renderTemplate };
