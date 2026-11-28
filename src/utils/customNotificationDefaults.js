// Admin "Custom notification": the app pages a notification can open, who
// each page is for, and the saved messages a new install starts with.

// Pages of the app a notification can open (data: { link: 'page', page }).
const NOTIFICATION_PAGES = [
  'cart',
  'wishlist',
  'coupons',
  'orders',
  'hot-deals',
  'popular',
  'coming-soon',
  'wholesaler',
  'negotiations',
  'signup',
];

// Pages that work without an account: the only ones a notification to
// phones that aren't signed in ("guests") can open. 'signup' opens Create
// account and is for those phones only.
const GUEST_PAGES = ['coupons', 'hot-deals', 'popular', 'coming-soon', 'signup'];
const GUEST_ONLY_PAGES = ['signup'];

// Pages only one kind of account can use: "Apply for Wholesaler" is for
// customers, "Ask your price" (negotiations) for wholesalers.
const PAGE_ROLES = {
  wholesaler: 'buyer',
  negotiations: 'wholesaler',
};

const MAX_NOTIFICATION_TEMPLATES = 50;
// "Chosen people": at most this many ids in one send (more: use a group).
const MAX_CHOSEN_PEOPLE = 2000;

// Settings.notificationTemplates starts with these ({name} is replaced with
// each person's first name when sent).
const DEFAULT_NOTIFICATION_TEMPLATES = [
  {
    name: 'New stock arrived',
    title: 'New stock arrived',
    body: 'Fresh stock of OXON tools and sprayers is in. Order now before it runs out.',
    titleHi: 'नया स्टॉक आ गया है',
    bodyHi: 'OXON के औज़ार और स्प्रेयर का नया स्टॉक आ गया है। ख़त्म होने से पहले ऑर्डर करें।',
    link: null,
    imageUrl: '',
  },
  {
    // A sale link needs a sale: the admin picks it after loading this.
    name: 'Sale is live (pick the sale)',
    title: 'The sale is live',
    body: 'Big discounts on OXON products for a few days only. Tap to see the sale.',
    titleHi: 'सेल शुरू हो गई है',
    bodyHi: 'कुछ ही दिनों के लिए OXON उत्पादों पर भारी छूट। सेल देखने के लिए टैप करें।',
    link: null,
    imageUrl: '',
  },
  {
    name: 'Become a wholesaler',
    title: 'Buy at wholesale prices',
    body: 'Run a shop? Apply for a wholesaler account and get wholesale prices on OXON products.',
    titleHi: 'थोक दाम पर ख़रीदें',
    bodyHi: 'दुकान चलाते हैं? होलसेलर खाते के लिए आवेदन करें और OXON उत्पाद थोक दाम पर पाएँ।',
    link: { type: 'page', page: 'wholesaler' },
    imageUrl: '',
  },
  {
    name: 'Your cart is waiting',
    title: 'Hi {name}, your cart is waiting',
    body: 'The items you picked are still in your cart. Complete your order before they sell out.',
    titleHi: 'नमस्ते {name}, आपका कार्ट इंतज़ार कर रहा है',
    bodyHi: 'आपके चुने हुए सामान अभी भी कार्ट में हैं। ख़त्म होने से पहले ऑर्डर पूरा करें।',
    link: { type: 'page', page: 'cart' },
    imageUrl: '',
  },
  {
    name: 'Price dropped on something you saved',
    title: 'Price dropped on something you saved',
    body: 'An item in your wishlist now costs less. Take a look before the price goes up.',
    titleHi: 'आपकी पसंद की चीज़ का दाम घटा',
    bodyHi: 'आपकी विशलिस्ट की एक चीज़ अब कम दाम में मिल रही है। दाम बढ़ने से पहले देख लें।',
    link: { type: 'page', page: 'wishlist' },
    imageUrl: '',
  },
  {
    name: 'New sprayer launching next week',
    title: 'New sprayer launching next week',
    body: "See what's coming to OXON and be the first to order.",
    titleHi: 'अगले हफ़्ते नया स्प्रेयर आ रहा है',
    bodyHi: 'देखें OXON में क्या नया आने वाला है और सबसे पहले ऑर्डर करें।',
    link: { type: 'page', page: 'coming-soon' },
    imageUrl: '',
  },
  {
    name: 'Buying in bulk? Ask your own price',
    title: 'Buying in bulk? Ask your own price',
    body: 'Send a price request for large orders and we will reply with our best offer.',
    titleHi: 'थोक में ख़रीद रहे हैं? अपना दाम पूछें',
    bodyHi: 'बड़े ऑर्डर के लिए अपना दाम भेजें, हम सबसे अच्छे ऑफ़र के साथ जवाब देंगे।',
    link: { type: 'page', page: 'negotiations' },
    imageUrl: '',
  },
  {
    name: 'Order delays during the festival',
    title: 'Order delays during the festival',
    body: 'Deliveries may take a few extra days during the festival. You can track your orders in the app.',
    titleHi: 'त्योहार के दौरान ऑर्डर में देरी',
    bodyHi: 'त्योहार के समय डिलीवरी में कुछ दिन ज़्यादा लग सकते हैं। ऐप में अपने ऑर्डर देख सकते हैं।',
    link: { type: 'page', page: 'orders' },
    imageUrl: '',
  },
  {
    name: 'Festival greetings',
    title: 'Happy festival from OXON',
    body: 'Wishing you and your family a happy and prosperous festival. Thank you for being with OXON.',
    titleHi: 'OXON की ओर से त्योहार की शुभकामनाएँ',
    bodyHi: 'आपको और आपके परिवार को त्योहार की ढेरों शुभकामनाएँ!',
    link: null,
    imageUrl: '',
  },
];

module.exports = {
  GUEST_PAGES,
  GUEST_ONLY_PAGES,
  NOTIFICATION_PAGES,
  PAGE_ROLES,
  MAX_NOTIFICATION_TEMPLATES,
  MAX_CHOSEN_PEOPLE,
  DEFAULT_NOTIFICATION_TEMPLATES,
};
