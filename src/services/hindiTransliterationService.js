const axios = require('axios');

const cache = new Map();

async function transliterateToHindi(text) {
  const input = (text || '').trim();
  if (!input) return input;

  if (cache.has(input)) {
    return cache.get(input);
  }

  const url = `https://inputtools.google.com/request?text=${encodeURIComponent(input)}&itc=hi-t-i0-und&num=1`;

  try {
    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;

    // Expected format: ["SUCCESS",[["text",["result1","result2"]]]]
    if (
      Array.isArray(data) &&
      data[0] === 'SUCCESS' &&
      Array.isArray(data[1]) &&
      Array.isArray(data[1][0]) &&
      Array.isArray(data[1][0][1]) &&
      typeof data[1][0][1][0] === 'string'
    ) {
      const result = data[1][0][1][0].trim();
      if (result) {
        cache.set(input, result);
        return result;
      }
    }
  } catch (error) {
    // Fall through to return original text.
  }

  return input;
}

module.exports = {
  transliterateToHindi,
};

