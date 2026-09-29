// Strict Indian mobile number validation used for registration/OTP endpoints.
//
// Rules:
//   1. Exactly 10 digits, first digit in [6-9].
//   2. Not all digits identical (e.g. 1111111111).
//   3. Not a cyclic ascending/descending run (e.g. 0123456789, 9876543210,
//      or a rotation of either such as 6789012345 / 6543210987).

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const ALL_SAME_DIGIT_REGEX = /^(\d)\1{9}$/;

function isSequentialRun(phone) {
  const digits = phone.split('').map(Number);
  let isAscending = true;
  let isDescending = true;

  for (let i = 1; i < digits.length; i++) {
    const diff = (digits[i] - digits[i - 1] + 10) % 10;
    if (diff !== 1) isAscending = false;
    if (diff !== 9) isDescending = false; // 9 === -1 (mod 10)
  }

  return isAscending || isDescending;
}

function isValidIndianMobile(phone) {
  if (typeof phone !== 'string') return false;
  if (!INDIAN_MOBILE_REGEX.test(phone)) return false;
  if (ALL_SAME_DIGIT_REGEX.test(phone)) return false;
  if (isSequentialRun(phone)) return false;
  return true;
}

function validateIndianPhoneJoi(value, helpers) {
  if (!isValidIndianMobile(value)) {
    return helpers.error('any.invalid');
  }
  return value;
}

module.exports = {
  INDIAN_MOBILE_REGEX,
  isValidIndianMobile,
  validateIndianPhoneJoi,
};
