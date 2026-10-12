// Version of the Terms and Privacy Policy shown in the app at signup.
// Bump when the legal text changes; the app sends the version it displayed.
const LEGAL_VERSION = '2026-10-12';

// Older builds that do not send an acceptance can still sign up until this is
// switched on (set REQUIRE_TERMS_ACCEPTANCE=true once the new app is rolled out).
const requireAcceptance = () => process.env.REQUIRE_TERMS_ACCEPTANCE === 'true';

/**
 * Builds the User fields that record what the person agreed to.
 * Returns {} when nothing was accepted (only possible while not required).
 */
const buildAcceptanceFields = (body = {}, now = new Date()) => {
  if (body.termsAccepted !== true || body.privacyPolicyAccepted !== true) return {};
  return {
    termsAcceptedAt: now,
    termsAcceptedVersion: body.termsVersion || LEGAL_VERSION,
    privacyAcceptedAt: now,
    privacyAcceptedVersion: body.privacyPolicyVersion || LEGAL_VERSION,
  };
};

module.exports = { LEGAL_VERSION, requireAcceptance, buildAcceptanceFields };
