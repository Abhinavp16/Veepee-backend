const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

function validateBusinessTimezone(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch (error) {
    throw new Error(`BUSINESS_TIMEZONE must be a valid IANA timezone: ${timeZone}`);
  }
}

const BUSINESS_TIMEZONE = validateBusinessTimezone(process.env.BUSINESS_TIMEZONE || DEFAULT_BUSINESS_TIMEZONE);

module.exports = { BUSINESS_TIMEZONE };
