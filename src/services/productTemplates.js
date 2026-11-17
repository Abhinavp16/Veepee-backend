// Text that most products share (Shipping & Returns, Warranty), kept once in
// Settings → Product templates. A product shows the shared text unless it
// has its own; changing the shared text changes it on every such product.

// The text new products used to get written into them. A product still
// holding exactly this has nothing of its own, so it follows the shared text.
const LEGACY_SHIPPING_TERMS = 'Free shipping on orders above ₹5,000. Standard delivery within 5-7 business days. Express delivery available at additional cost.\n\nReturn Policy: Products can be returned within 7 days of delivery if unused and in original packaging. Damaged or defective items will be replaced free of charge. Refunds are processed within 5-7 business days after the returned item is received and inspected.';

// The starting warranty text, from the website's Warranty Policy.
const DEFAULT_WARRANTY = 'OXON products carry the manufacturer or company warranty mentioned on this page. It covers manufacturing defects only.\n\nNot covered: damage from misuse, accidents, improper installation, unauthorised repairs or modifications, normal wear and tear, and consumable parts.\n\nTo claim, contact OXON support within the warranty period with your order number and photos of the problem. The warranty is void if safety instructions or operating guidelines are not followed.';

/**
 * Whether a product shows the shared text for one policy. Products from
 * before this choice existed (`useCommon` not set) follow the shared text
 * unless they hold text of their own: an empty box there only meant it was
 * left blank (the app then showed its built-in text), as did the old
 * built-in text. Only a product switched off in the admin shows nothing
 * when its own box is empty.
 */
function followsCommon(useCommon, ownText, legacyDefault = null) {
  if (useCommon === true) return true;
  if (useCommon === false) return false;
  const own = ownText == null ? '' : String(ownText).trim();
  return own === '' || (legacyDefault != null && ownText === legacyDefault);
}

/**
 * The Shipping & Returns and Warranty text a shopper sees for [product], or
 * null for none (the app then leaves the section out; app versions from
 * before show their own built-in shipping text for null, as they always did).
 */
function productPolicies(product, settings) {
  const templates = settings?.productTemplates || {};
  const shared = (value) => String(value || '').trim() || null;
  const own = (value) => (value == null ? null : String(value).trim() || null);
  return {
    shippingTerms: followsCommon(product.useCommonShipping, product.shippingTerms, LEGACY_SHIPPING_TERMS)
      ? shared(templates.shippingTerms)
      : own(product.shippingTerms),
    warranty: followsCommon(product.useCommonWarranty, product.warranty)
      ? shared(templates.warranty)
      : own(product.warranty),
  };
}

module.exports = { LEGACY_SHIPPING_TERMS, DEFAULT_WARRANTY, followsCommon, productPolicies };
