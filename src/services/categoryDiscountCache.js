// The category tree with discount percentages, kept for a short time so a
// cart or product request does not reload every category each time. Any
// change to a category clears it (see the hooks in models/Category.js);
// other server instances pick changes up within CACHE_MS.
const CACHE_MS = 30 * 1000;

let cached = null;

const getCachedCategories = async (load) => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await load();
  cached = { at: Date.now(), value };
  return value;
};

const clearCategoryCache = () => {
  cached = null;
};

module.exports = { getCachedCategories, clearCategoryCache };
