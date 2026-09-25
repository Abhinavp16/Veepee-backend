const idString = (value) => value == null ? null : String(value?._id || value);

function sortCategoriesByTree(categories) {
  const categoryIds = new Set(categories.map((category) => String(category._id)));
  const children = new Map();
  const compare = (left, right) => (
    (Number(left.order) || 0) - (Number(right.order) || 0)
    || String(left.name || '').localeCompare(String(right.name || ''))
    || String(left._id).localeCompare(String(right._id))
  );

  for (const category of categories) {
    const parentId = idString(category.parent);
    const key = parentId && categoryIds.has(parentId) ? parentId : null;
    children.set(key, [...(children.get(key) || []), category]);
  }
  for (const siblings of children.values()) siblings.sort(compare);

  const sorted = [];
  const visited = new Set();
  const append = (parentId) => {
    for (const category of children.get(parentId) || []) {
      const categoryId = String(category._id);
      if (visited.has(categoryId)) continue;
      visited.add(categoryId);
      sorted.push(category);
      append(categoryId);
    }
  };
  append(null);
  for (const category of [...categories].sort(compare)) {
    if (!visited.has(String(category._id))) sorted.push(category);
  }
  return sorted;
}

function getCompanyCategoryCounts(categories, directProductSets) {
  const children = new Map();
  for (const category of categories) {
    const parentId = idString(category.parent);
    children.set(parentId, [...(children.get(parentId) || []), String(category._id)]);
  }

  const memo = new Map();
  const collect = (categoryId, visiting = new Set()) => {
    if (memo.has(categoryId)) return memo.get(categoryId);
    const products = new Set(directProductSets.get(categoryId) || []);
    if (visiting.has(categoryId)) return products;
    const nextVisiting = new Set(visiting).add(categoryId);
    for (const childId of children.get(categoryId) || []) {
      for (const productId of collect(childId, nextVisiting)) products.add(productId);
    }
    memo.set(categoryId, products);
    return products;
  };

  return new Map(categories.map((category) => {
    const categoryId = String(category._id);
    return [categoryId, {
      directProductCount: new Set(directProductSets.get(categoryId) || []).size,
      recursiveProductCount: collect(categoryId).size,
    }];
  }));
}

module.exports = { getCompanyCategoryCounts, sortCategoriesByTree };
