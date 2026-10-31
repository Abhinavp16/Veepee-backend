// Product search, scored in code: the catalogue is a few hundred products,
// small enough to read once per search, and scoring here gives what a plain
// database regex can't: specifications, units written any way ("850w",
// "850 w", "850 watt"), best match first, typo tolerance and Hindi words.

// Units: "850 Watt", "850w" and "850 w" all become "850w".
const UNITS = [
  ['w', 'watts?|w'],
  ['kw', 'kilowatts?|kw'],
  ['hp', 'horse\\s*power|hp'],
  ['cc', 'cc'],
  ['mm', 'millimet(?:er|re)s?|mm'],
  ['cm', 'centimet(?:er|re)s?|cm'],
  ['inch', 'inch(?:es)?|in|"'],
  ['kg', 'kilograms?|kgs?'],
  ['l', 'lit(?:er|re)s?|ltrs?|l'],
  ['ml', 'ml'],
  ['rpm', 'rpm'],
  ['v', 'volts?|v'],
  ['ft', 'feet|foot|ft'],
];
const UNIT_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(${UNITS.map(([, forms]) => `(?:${forms})`).join('|')})(?![a-z])`,
  'gi'
);
const unitFor = (raw) => {
  const value = raw.toLowerCase();
  for (const [unit, forms] of UNITS) {
    if (new RegExp(`^(?:${forms})$`, 'i').test(value)) return unit;
  }
  return value;
};

// Words written as one or two ("chain saw", "chainsaw") match either way.
const COMPOUNDS = [
  ['chainsaw', 'chain saw'],
  ['brushcutter', 'brush cutter'],
  ['powerweeder', 'power weeder'],
  ['waterpump', 'water pump'],
  ['earthauger', 'earth auger'],
  ['ricemill', 'rice mill'],
  ['chaffcutter', 'chaff cutter'],
];

// Hindi (and Hinglish) words people type, to the catalogue's English.
const HINDI = {
  'पंप': 'pump', 'पम्प': 'pump', 'मोटर': 'motor', 'इंजन': 'engine',
  'स्प्रेयर': 'sprayer', 'छिड़काव': 'sprayer', 'वीडर': 'weeder', 'निराई': 'weeder',
  'ग्राइंडर': 'grinder', 'आरा': 'saw', 'चेनसॉ': 'chainsaw', 'कटर': 'cutter',
  'जनरेटर': 'generator', 'बीज': 'seed', 'पाइप': 'pipe', 'पानी': 'water',
  'चक्की': 'mill', 'धान': 'rice', 'चावल': 'rice', 'ड्रिल': 'drill',
  'वेल्डिंग': 'welding', 'कंप्रेसर': 'compressor', 'पुर्जे': 'spare', 'पार्ट्स': 'parts',
  'बैटरी': 'battery', 'तार': 'wire', 'ब्लेड': 'blade', 'हल': 'plough',
};

const SPARE_WORDS = /\b(spares?|parts?|stator|armature|carbon|gasket|bearing|kit)\b/;

/** Lower case, punctuation as spaces, units and compounds in one form. */
function normalizeText(value) {
  let text = String(value || '').toLowerCase();
  text = text.replace(/[(),/\\|:;+_*#&!?'’\-–—[\]{}]/g, ' ');
  // A full stop that isn't a decimal point ("pump." but not "1.5").
  text = text.replace(/\.(?!\d)/g, ' ');
  text = text.replace(UNIT_PATTERN, (_, number, unit) => ` ${number}${unitFor(unit)} `);
  // Both forms kept, so either is found ("chain saw" and "chainsaw").
  for (const [joined, split] of COMPOUNDS) {
    text = text.replace(
      new RegExp(`\\b(?:${split.replace(' ', '\\s+')}|${joined})\\b`, 'g'),
      ` ${split} ${joined} `
    );
  }
  return ` ${text.replace(/\s+/g, ' ').trim()} `;
}

/**
 * The words of a search, each with the ways it may appear. A Hindi word is
 * also looked for in English.
 */
function searchTerms(query) {
  const text = normalizeText(query).trim();
  if (!text) return [];
  return [...new Set(text.split(' '))].map((word) => {
    const forms = new Set([word]);
    if (HINDI[word]) forms.add(normalizeText(HINDI[word]).trim());
    return { word, forms: [...forms] };
  });
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A word matches at the start of a word in the text ("grind" finds grinder).
const startsWordIn = (text, form) => text.includes(` ${form}`);
const wholeWordIn = (text, form) => new RegExp(` ${escape(form)} `).test(text);

// How much each part of a product counts when a word is found in it.
const FIELD_WEIGHTS = [
  ['name', 10], ['nameHindi', 10], ['sku', 8], ['brand', 6],
  ['places', 5], ['specs', 4], ['tags', 4], ['short', 2], ['description', 1],
];

/** A product's searchable text, normalized once. */
function searchableProduct(product, { categoryNames = new Map(), subCategoryNames = new Map() } = {}) {
  const places = [
    product.category,
    ...(product.categoryIds || []).map((id) => categoryNames.get(String(id))),
    categoryNames.get(String(product.primaryCategoryId)),
    ...(product.placements || []).flatMap((p) => [
      categoryNames.get(String(p.category)),
      subCategoryNames.get(String(p.subCategory)),
    ]),
  ].filter(Boolean);
  const fields = {
    name: normalizeText(product.name),
    nameHindi: normalizeText(product.nameHindi),
    sku: normalizeText(product.sku),
    brand: normalizeText([product.brand, product.company?.name].filter(Boolean).join(' ')),
    places: normalizeText(places.join(' ')),
    specs: normalizeText((product.specifications || []).map((s) => `${s.key} ${s.value}`).join(' ')),
    tags: normalizeText((product.tags || []).join(' ')),
    short: normalizeText(product.shortDescription),
    description: normalizeText(product.description),
  };
  return { product, fields, isSpare: SPARE_WORDS.test(fields.name + fields.places) };
}

/**
 * How well a product matches, or 0 when some word isn't found anywhere.
 * Each word scores by the best part it's in; the name starting with the
 * search, or holding all of it, counts most.
 */
function scoreProduct(entry, terms, query) {
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const text = entry.fields[field];
      if (!text || text.length < 3) continue;
      for (const form of term.forms) {
        if (wholeWordIn(text, form)) best = Math.max(best, weight + 1);
        else if (startsWordIn(text, form)) best = Math.max(best, weight);
      }
    }
    if (best === 0) return 0;
    score += best;
  }
  const phrase = normalizeText(query).trim();
  const name = entry.fields.name.trim();
  if (phrase && name.startsWith(phrase)) score += 20;
  else if (phrase && entry.fields.name.includes(` ${phrase}`)) score += 10;
  // Spare parts after the machines, unless parts are what's searched for.
  if (entry.isSpare && !SPARE_WORDS.test(` ${phrase} `)) score -= 6;
  return score;
}

/**
 * Letters to add, remove, change or swap with a neighbour to turn [a] into
 * [b] ("wedeer" → "weeder" is one swap). Stops counting past [limit].
 */
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let rowBest = Infinity;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
      rowBest = Math.min(rowBest, d[i][j]);
    }
    if (rowBest > limit) return limit + 1;
  }
  return d[a.length][b.length];
}

/**
 * When nothing matched: the search with misspelt words replaced by the
 * closest word in the catalogue ("wedeer" → "weeder"), or null.
 */
function correctedQuery(query, entries) {
  const words = normalizeText(query).trim().split(' ').filter(Boolean);
  const vocabulary = new Map();
  for (const entry of entries) {
    for (const field of ['name', 'places', 'specs', 'brand', 'tags']) {
      for (const word of entry.fields[field].trim().split(' ')) {
        if (/^[a-z]{4,}$/.test(word)) vocabulary.set(word, (vocabulary.get(word) || 0) + 1);
      }
    }
  }
  let changed = false;
  const fixed = words.map((word) => {
    if (!/^[a-z]{4,}$/.test(word) || vocabulary.has(word)) return word;
    if ([...vocabulary.keys()].some((known) => known.startsWith(word))) return word;
    const limit = word.length >= 7 ? 2 : 1;
    let best = null;
    for (const [known, count] of vocabulary) {
      const distance = editDistance(word, known, limit);
      if (distance > limit) continue;
      if (!best || distance < best.distance || (distance === best.distance && count > best.count)) {
        best = { known, distance, count };
      }
    }
    if (!best) return word;
    changed = true;
    return best.known;
  });
  return changed ? fixed.join(' ') : null;
}

/**
 * The products matching [query], best first. When nothing matches, tries
 * the search with spelling corrected and says so in `correctedQuery`.
 */
function rankProducts(products, query, names = {}, { comingSoonLast = false } = {}) {
  const entries = products.map((product) => searchableProduct(product, names));
  const run = (text) => {
    const terms = searchTerms(text);
    return entries
      .map((entry) => ({ entry, score: scoreProduct(entry, terms, text) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => {
        if (comingSoonLast && Boolean(a.entry.product.comingSoon) !== Boolean(b.entry.product.comingSoon)) {
          return a.entry.product.comingSoon ? 1 : -1;
        }
        return b.score - a.score
          || new Date(b.entry.product.createdAt || 0) - new Date(a.entry.product.createdAt || 0);
      })
      .map((hit) => hit.entry.product);
  };
  const results = run(query);
  if (results.length > 0) return { products: results, correctedQuery: null };
  const corrected = correctedQuery(query, entries);
  if (!corrected) return { products: [], correctedQuery: null };
  return { products: run(corrected), correctedQuery: corrected };
}

module.exports = { normalizeText, searchTerms, scoreProduct, searchableProduct, correctedQuery, rankProducts, editDistance };
