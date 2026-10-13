// Fills the local development database with realistic test data.
// Wipes the dev database first. Refuses to run against anything but localhost.
//   node scripts/dev/seedDev.js
const { uri } = require('./devEnv');
const mongoose = require('mongoose');

const img = (text, bg = 'F59E0B') =>
  `https://placehold.co/600x600/${bg}/FFFFFF/png?text=${encodeURIComponent(text)}`;

async function main() {
  await mongoose.connect(uri);
  const models = require('../../src/models');
  const { User, Category, Company, Product, Settings, WebsiteSettings, Offer, AffiliateCode, Review } = models;

  await mongoose.connection.db.dropDatabase();
  for (const [name, model] of Object.entries(models)) {
    if (!model?.syncIndexes) continue;
    try {
      await model.syncIndexes();
    } catch (error) {
      console.warn(`Index warning for ${name}: ${error.message.split('.')[0]}`);
    }
  }

  // --- People -------------------------------------------------------------
  const people = await User.create([
    { name: 'Dev Admin', email: 'admin@veepee.dev', passwordHash: 'Admin@12345', authProvider: 'email', role: 'admin', isActive: true },
    { name: 'Dev Staff', email: 'staff@veepee.dev', passwordHash: 'Staff@12345', authProvider: 'email', role: 'staff', isActive: true },
    { name: 'Asha Buyer', phone: '9812345670', passwordHash: 'Buyer@123', authProvider: 'email', role: 'buyer', address: '12 MG Road, Raipur' },
    { name: 'Ravi Buyer', phone: '9812345672', passwordHash: 'Buyer@123', authProvider: 'email', role: 'buyer', preferredLanguage: 'hi' },
    {
      name: 'Wahid Wholesale', phone: '9812345671', passwordHash: 'Whole@123', authProvider: 'email', role: 'wholesaler',
      businessInfo: { businessName: 'Wahid Agro Traders', gstNumber: '22AAAAA0000A1Z5', status: 'accepted', verified: true, verifiedAt: new Date() },
    },
    {
      name: 'Pooja Applicant', phone: '9812345673', passwordHash: 'Buyer@123', authProvider: 'email', role: 'buyer',
      businessInfo: { businessName: 'Pooja Farm Supplies', gstNumber: '22BBBBB0000B1Z5', businessAddress: 'Bilaspur', contactPerson: 'Pooja', status: 'pending', proofImages: [img('GST proof', '57534E')] },
    },
  ]);

  // --- Catalogue ------------------------------------------------------------
  const [machinery, tools, irrigation] = await Category.create([
    { name: 'Farm Machinery', order: 1, image: { url: img('Machinery', '1C1917') } },
    { name: 'Hand Tools', order: 2, image: { url: img('Tools', '57534E') } },
    { name: 'Irrigation', order: 3, image: { url: img('Irrigation', '0EA5E9') } },
  ]);
  const [sprayers, pumps] = await Category.create([
    { name: 'Sprayers', parent: machinery._id, order: 1 },
    { name: 'Water Pumps', parent: irrigation._id, order: 1 },
  ]);
  // Irrigation: 10% off MRP for customers, 25% for wholesalers.
  await Category.updateOne({ _id: irrigation._id }, { $set: { customerDiscountPercent: 10, wholesalerDiscountPercent: 25 } });

  const [kirlo, agriplus, ecotech, vflow] = await Company.create([
    { name: 'Kirlo', description: 'Pumps and motors', logo: { url: img('Kirlo', '0369A1') }, displayOrder: 1, categoryIds: [irrigation._id, pumps._id] },
    { name: 'AgriPlus', description: 'Sprayers', logo: { url: img('AgriPlus', '15803D') }, displayOrder: 2, categoryIds: [machinery._id, sprayers._id] },
    { name: 'EcoTech', description: 'Hand tools', logo: { url: img('EcoTech', '7C3AED') }, displayOrder: 3, categoryIds: [tools._id] },
    { name: 'V-Flow', description: 'Pipes and fittings', logo: { url: img('V-Flow', 'DC2626') }, displayOrder: 4, categoryIds: [irrigation._id] },
  ]);
  // AgriPlus: 5% off MRP for customers.
  await Company.updateOne({ _id: agriplus._id }, { $set: { customerDiscountPercent: 5 } });

  const product = (fields) => ({
    description: `${fields.name} — dependable, field-tested and backed by Veepee Impex support.`,
    shortDescription: `${fields.name} for everyday farm work`,
    stock: 50, status: 'active', minWholesaleQuantity: 1,
    images: [{ url: img(fields.name), publicId: `dev/${fields.sku}`, isPrimary: true, order: 0 }],
    specifications: [{ key: 'feature_1', value: 'Heavy-duty build' }, { key: 'feature_2', value: '1-year warranty' }],
    ...fields,
  });
  const products = await Product.create([
    product({ name: 'Kirlo 1HP Water Pump', sku: 'DEV-PUMP-1', category: 'water-pumps', categoryIds: [pumps._id], primaryCategoryId: pumps._id, company: kirlo._id, mrp: 8500, retailPrice: 7999, wholesalePrice: 6800, isFeatured: true, isHot: true }),
    product({ name: 'Kirlo 2HP Submersible Pump', sku: 'DEV-PUMP-2', category: 'water-pumps', categoryIds: [pumps._id], primaryCategoryId: pumps._id, company: kirlo._id, mrp: 18500, retailPrice: 16999, wholesalePrice: 14800, isFeatured: true, stock: 3, lowStockThreshold: 5 }),
    product({ name: 'AgriPlus 16L Battery Sprayer', sku: 'DEV-SPR-16', category: 'sprayers', categoryIds: [sprayers._id], primaryCategoryId: sprayers._id, company: agriplus._id, mrp: 3200, retailPrice: 2899, wholesalePrice: 2350, isFeatured: true, isHot: true }),
    product({ name: 'AgriPlus Knapsack Sprayer', sku: 'DEV-SPR-KN', category: 'sprayers', categoryIds: [sprayers._id], primaryCategoryId: sprayers._id, company: agriplus._id, mrp: 1800, retailPrice: 1599, wholesalePrice: 1250, stock: 0 }),
    product({ name: 'EcoTech Pruning Shears', sku: 'DEV-TOOL-PS', category: 'hand-tools', categoryIds: [tools._id], primaryCategoryId: tools._id, company: ecotech._id, mrp: 650, retailPrice: 549, wholesalePrice: 420, isHot: true, packSize: 12, priceUnit: 'piece', minWholesaleQuantity: 2, minCustomerQuantity: 1 }),
    product({ name: 'EcoTech Garden Hoe', sku: 'DEV-TOOL-HOE', category: 'hand-tools', categoryIds: [tools._id], primaryCategoryId: tools._id, company: ecotech._id, mrp: 480, retailPrice: 399, wholesalePrice: 310, minCustomerQuantity: 2 }),
    product({ name: 'V-Flow 1 inch PVC Pipe (50 m coil)', sku: 'DEV-PIPE-50', category: 'irrigation', categoryIds: [irrigation._id], primaryCategoryId: irrigation._id, company: vflow._id, mrp: 2400, retailPrice: 2199, wholesalePrice: 1800, priceUnit: 'coil' }),
    product({ name: 'V-Flow Drip Kit (Coming Soon)', sku: 'DEV-DRIP-CS', category: 'irrigation', categoryIds: [irrigation._id], primaryCategoryId: irrigation._id, company: vflow._id, mrp: 5500, retailPrice: 4999, wholesalePrice: 4100, comingSoon: true, expectedLaunchDate: new Date(Date.now() + 10 * 86400000) }),
    product({ name: 'AgriPlus Power Weeder (Coming Soon)', sku: 'DEV-WEED-CS', category: 'farm-machinery', categoryIds: [machinery._id], primaryCategoryId: machinery._id, company: agriplus._id, mrp: 45000, retailPrice: 41999, wholesalePrice: 37000, comingSoon: true, hidePriceWhileComingSoon: true }),
    product({ name: 'Draft Tiller (not published)', sku: 'DEV-TILL-DR', category: 'farm-machinery', categoryIds: [machinery._id], primaryCategoryId: machinery._id, mrp: 60000, retailPrice: 55000, wholesalePrice: 50000, status: 'draft' }),
    product({ name: 'Old Hand Pump (archived)', sku: 'DEV-OLD-HP', category: 'irrigation', categoryIds: [irrigation._id], primaryCategoryId: irrigation._id, mrp: 2000, retailPrice: 1800, wholesalePrice: 1500, status: 'archived' }),
    product({ name: 'Brass Spray Nozzle', sku: 'DEV-NOZ-BR', category: 'sprayers', categoryIds: [sprayers._id], primaryCategoryId: sprayers._id, mrp: 250, retailPrice: 199, wholesalePrice: 140, negotiationEnabled: true }),
  ]);
  for (const c of [kirlo, agriplus, ecotech, vflow]) {
    await Company.updateOne({ _id: c._id }, { $set: { productCount: products.filter((p) => String(p.company) === String(c._id)).length } });
  }

  // --- Settings, website, offers, reviews -------------------------------------
  await Settings.create({
    _id: 'app_settings',
    businessName: 'VeepeeImpex (Dev)', businessPhone: '+919999999999', businessEmail: 'dev@veepee.dev',
    upiId: 'veepeeimpex.dev@upi', upiDisplayName: 'VeepeeImpex Dev',
    bankName: 'Dev Bank', bankAccountNumber: '000111222333', bankIfscCode: 'DEVB0000001', bankAccountHolderName: 'Veepee Impex',
    socialLinks: { whatsapp: '919999999999' },
    heroBanners: [
      { title: 'Monsoon Pump Sale', subtitle: 'Up to 20% off Kirlo pumps', tag: 'SALE', imageUrl: img('Monsoon Sale', '0369A1'), linkUrl: `/product/${products[0]._id}`, isActive: true, order: 0 },
      { title: 'New Sprayers', subtitle: 'Battery sprayers in stock', tag: 'NEW', imageUrl: img('Sprayers', '15803D'), linkUrl: '', isActive: true, order: 1 },
    ],
    promoBanners: [
      { title: 'Bulk Orders', subtitle: 'Wholesale prices for dealers', imageUrl: img('Bulk Orders', '7C3AED'), isActive: true, order: 0 },
    ],
  });
  await WebsiteSettings.getSettings();
  await WebsiteSettings.updateOne({}, { $set: { labels: [
    { id: 'warranty', title: '1 Year Warranty', sourceType: 'icon', icon: 'ShieldCheck', order: 0 },
    { id: 'made-in-india', title: 'Made in India', sourceType: 'icon', icon: 'Flag', order: 1 },
  ] } });
  await Product.updateOne({ _id: products[0]._id }, { $set: { labelIds: ['warranty', 'made-in-india'] } });

  await Offer.create([
    { title: 'Welcome 10% off', description: 'For your first order', discountType: 'percentage', discountValue: 10, code: 'WELCOME10', targetGroup: 'buyer', minPurchaseAmount: 500, maxDiscountAmount: 1000, isActive: true, startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 30 * 86400000) },
    { title: 'Dealer ₹500 off', description: 'On orders above ₹10,000', discountType: 'fixed', discountValue: 500, code: 'DEALER500', targetGroup: 'wholesaler', minPurchaseAmount: 10000, isActive: true, startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 30 * 86400000) },
  ]);
  await AffiliateCode.create({ code: 'RAMESH5', personName: 'Ramesh Agent', discountType: 'percentage', discountValue: 5, isActive: true, startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 60 * 86400000) });
  await Review.create([
    { name: 'Rajesh Kumar', role: 'Farmer, Punjab', review: 'Pump works perfectly for my 5 acres.', rating: 5, isActive: true },
    { name: 'Sunita Devi', role: 'Dealer, Raipur', review: 'Good wholesale rates and quick delivery.', rating: 4, isActive: true },
    { name: 'Hidden Review', role: 'Test', review: 'This one is inactive.', rating: 2, isActive: false },
  ]);

  console.log('Dev database seeded:', uri);
  console.log('  admin  admin@veepee.dev / Admin@12345');
  console.log('  staff  staff@veepee.dev / Staff@12345 (staff area: /member/login)');
  console.log('  buyer  9812345670 / Buyer@123     buyer (Hindi) 9812345672 / Buyer@123');
  console.log('  wholesaler 9812345671 / Whole@123   applicant 9812345673 / Buyer@123');
  console.log(`  ${products.length} products, ${people.length} users`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
