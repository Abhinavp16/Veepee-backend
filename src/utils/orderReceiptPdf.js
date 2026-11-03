const { ORDER_CONFIRMATION, ORDER_STATUS } = require('./constants');
const {
  DEFAULT_GSTIN,
  formatDateTime,
  formatCurrency,
  formatAmount,
  wrapText,
  createPageWriter,
  sendPdf,
} = require('./pdfDocument');

// Order receipt PDF (A4). Ported from the Laxmi Agro receipt; Oxon orders
// have no packs or variants.

/** Receipts exist once the shop has confirmed the order (and not cancelled it). */
const isReceiptAvailable = (order = {}) => order.status !== ORDER_STATUS.CANCELLED
  && order.confirmationStatus !== ORDER_CONFIRMATION.PENDING
  && order.confirmationStatus !== ORDER_CONFIRMATION.REJECTED;

const paymentLabel = (status) => {
  if (status === ORDER_STATUS.PENDING_PAYMENT) return 'Awaiting payment';
  if (status === ORDER_STATUS.PAYMENT_UPLOADED) return 'Payment under review';
  return 'Paid';
};

const buildAddressLines = (shippingAddress = {}) => {
  const lines = [];
  if (shippingAddress.fullName) lines.push(shippingAddress.fullName);
  if (shippingAddress.phone) lines.push(`Phone: ${shippingAddress.phone}`);
  if (shippingAddress.addressLine1) lines.push(shippingAddress.addressLine1);
  if (shippingAddress.addressLine2) lines.push(shippingAddress.addressLine2);
  const cityState = [shippingAddress.city, shippingAddress.state].filter(Boolean).join(', ');
  const pincode = shippingAddress.pincode ? ` - ${shippingAddress.pincode}` : '';
  if (cityState || pincode) {
    lines.push(`${cityState}${pincode}`.trim());
  }
  return lines.filter(Boolean);
};

/**
 * The receipt; with [summary], the same layout titled "Order Summary" for an
 * order the shop hasn't confirmed yet (sent to OXON when it's placed).
 */
const createOrderReceiptPdfBuffer = async ({ order, settings, summary = false }) => {
  const w = createPageWriter({ settings, title: summary ? 'Order Summary' : 'Order Receipt' });
  const { MARGIN, PAGE_WIDTH } = w;
  const { drawText, drawTextRight, drawLine, ensureSpace } = w;

  const metaPairs = [
    ['Order Number', order.orderNumber || '-'],
    ['Order Date', formatDateTime(order.createdAt)],
    ...(order.confirmedAt ? [['Confirmed', formatDateTime(order.confirmedAt)]] : []),
    ...(order.customerSnapshot?.businessName ? [['Shop', order.customerSnapshot.businessName]] : []),
    ['Customer', order.customerSnapshot?.name || order.shippingAddress?.fullName || '-'],
    ['Phone', order.customerSnapshot?.phone || order.shippingAddress?.phone || '-'],
    ...(order.customerSnapshot?.email ? [['Email', order.customerSnapshot.email]] : []),
    ['Order Type', order.orderType === 'wholesale' ? 'Wholesale' : 'Retail'],
    ['Payment', paymentLabel(order.status)],
  ];

  // Order details on the left, shipping address on the right.
  const addressX = MARGIN + 305;
  const addressLines = buildAddressLines(order.shippingAddress).flatMap((line) => wrapText(line, 40));
  const metaHeight = metaPairs.reduce((sum, [, value]) => sum + (wrapText(value, 30).length * 14), 0);
  ensureSpace(Math.max(metaHeight, 16 + (addressLines.length * 12)) + 8);
  const blockTop = w.y;

  metaPairs.forEach(([label, value]) => {
    drawText(`${label}:`, MARGIN, w.y, { size: 11, font: 'F2' });
    wrapText(value, 30).forEach((line) => {
      drawText(line, MARGIN + 95, w.y, { size: 11 });
      w.y -= 14;
    });
  });
  const metaBottom = w.y;

  w.y = blockTop;
  drawText('Shipping Address', addressX, w.y, { size: 12, font: 'F2' });
  w.y -= 15;
  addressLines.forEach((line) => {
    drawText(line, addressX, w.y, { size: 10 });
    w.y -= 12;
  });
  w.y = Math.min(w.y, metaBottom);

  w.y -= 6;
  ensureSpace(26);
  drawLine(MARGIN, w.y, PAGE_WIDTH - MARGIN, w.y, 0.8);
  w.y -= 16;
  drawText('Product', MARGIN, w.y, { size: 11, font: 'F2' });
  drawText('Qty', MARGIN + 290, w.y, { size: 11, font: 'F2' });
  drawText('Rate (Rs.)', MARGIN + 345, w.y, { size: 11, font: 'F2' });
  drawTextRight('Total (Rs.)', PAGE_WIDTH - MARGIN, w.y, { size: 11, font: 'F2' });
  w.y -= 10;
  drawLine(MARGIN, w.y, PAGE_WIDTH - MARGIN, w.y, 0.8);
  w.y -= 14;

  for (const [index, item] of (order.items || []).entries()) {
    const productLines = [
      ...wrapText(item.productSnapshot?.name || `Item ${index + 1}`, 42),
      ...(item.productSnapshot?.sku ? [`SKU: ${item.productSnapshot.sku}`] : []),
    ];

    const rowHeight = Math.max(28, (productLines.length * 12) + 12);
    ensureSpace(rowHeight + 12);

    drawText(productLines[0], MARGIN, w.y, { size: 10, font: 'F2' });
    drawText(String(item.quantity || 0), MARGIN + 290, w.y, { size: 10 });
    drawText(formatAmount(item.pricePerUnit), MARGIN + 345, w.y, { size: 10 });
    drawTextRight(formatAmount(item.totalPrice), PAGE_WIDTH - MARGIN, w.y, { size: 10 });

    let lineY = w.y - 12;
    for (let lineIndex = 1; lineIndex < productLines.length; lineIndex += 1) {
      drawText(productLines[lineIndex], MARGIN, lineY, { size: 9 });
      lineY -= 11;
    }

    w.y -= rowHeight;
    drawLine(MARGIN, w.y + 13, PAGE_WIDTH - MARGIN, w.y + 13, 0.35);
  }

  w.y -= 8;
  const totals = [['Subtotal', formatCurrency(order.subtotal)]];
  if (Number(order.discount || 0) > 0) {
    totals.push(['Coupon Discount', `- ${formatCurrency(order.discount)}`]);
  }
  totals.push(['Delivery', Number(order.deliveryFee || 0) > 0 ? formatCurrency(order.deliveryFee) : 'Free']);
  if (Number(order.extraDiscount || 0) > 0) {
    const percent = order.extraDiscountPercent != null ? ` (${order.extraDiscountPercent}%)` : '';
    totals.push([`Extra Discount${percent}`, `- ${formatCurrency(order.extraDiscount)}`]);
  }
  totals.push(['Grand Total', formatCurrency(order.total)]);

  totals.forEach(([label, value], index) => {
    ensureSpace(16);
    const grand = label === 'Grand Total';
    drawText(label, MARGIN + 300, w.y, { size: grand ? 12 : 10, font: grand ? 'F2' : 'F1' });
    drawTextRight(value, PAGE_WIDTH - MARGIN, w.y, { size: grand ? 12 : 10, font: grand ? 'F2' : 'F1' });
    w.y -= index === totals.length - 1 ? 18 : 14;
  });

  if (order.customerNote) {
    ensureSpace(24);
    drawText('Customer Note', MARGIN, w.y, { size: 11, font: 'F2' });
    w.y -= 14;
    wrapText(order.customerNote, 78).forEach((line) => {
      ensureSpace(12);
      drawText(line, MARGIN, w.y, { size: 10 });
      w.y -= 12;
    });
  }

  ensureSpace(42);
  w.y -= 14;
  if (summary) {
    drawText('Order placed in the OXON app. Awaiting confirmation by OXON; this is not a bill.', MARGIN, w.y, { size: 9, font: 'F2' });
  } else {
    drawText('This is a computer-generated receipt. Thank you for shopping with OXON.', MARGIN, w.y, { size: 9 });
    w.y -= 12;
    const contact = settings?.businessPhone ? ` at ${settings.businessPhone}` : '';
    drawText(`For the GST original, please contact us${contact}.`, MARGIN, w.y, { size: 9, font: 'F2' });
  }

  return w.finish();
};

// "Ravi-Traders-ORD-2026-9001.pdf": shop name (else customer name) + order number.
const receiptFileName = (order = {}) => {
  const clean = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  const who = clean(order.customerSnapshot?.businessName)
    || clean(order.customerSnapshot?.name)
    || clean(order.shippingAddress?.fullName)
    || 'Receipt';
  const number = clean(order.orderNumber) || String(order._id || '');
  return `${who}-${number}.pdf`;
};

/** Sends the receipt PDF; the file name is also in X-Receipt-Filename. */
const sendOrderReceipt = async (res, order, settings, { summary = false } = {}) => {
  const buffer = await createOrderReceiptPdfBuffer({ order, settings, summary });
  sendPdf(res, buffer, receiptFileName(order));
};

module.exports = {
  DEFAULT_GSTIN,
  createOrderReceiptPdfBuffer,
  isReceiptAvailable,
  receiptFileName,
  sendOrderReceipt,
};
