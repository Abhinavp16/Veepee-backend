const assert = require('assert');
const { isValidIndianMobile } = require('../src/utils/phoneValidator');

let passed = 0;
let failed = 0;

function check(description, phone, expected) {
  try {
    assert.strictEqual(isValidIndianMobile(phone), expected);
    console.log(`PASS: ${description}`);
    passed++;
  } catch (error) {
    console.error(`FAIL: ${description}`);
    console.error(`  expected isValidIndianMobile(${JSON.stringify(phone)}) to be ${expected}`);
    failed++;
  }
}

check('accepts a real-looking Indian mobile number', '6234567890', true);
check('accepts a number starting with 9', '9812345670', true);
check('rejects all-same-digit number', '1111111111', false);
check('rejects all-same-digit number starting with a valid digit', '6666666666', false);
check('rejects literal ascending sequence', '0123456789', false);
check('rejects literal descending sequence', '9876543210', false);
check('rejects cyclic rotation of ascending sequence', '6789012345', false);
check('rejects cyclic rotation of descending sequence', '6543210987', false);
check('rejects wrong leading digit', '5123456789', false);
check('rejects too-short number', '987654321', false);
check('rejects too-long number', '98765432101', false);
check('rejects non-digit characters', '98765abcde', false);
check('rejects +91-prefixed number (no prefix tolerance)', '+919876543210', false);
check('rejects empty string', '', false);
check('rejects non-string input', null, false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
