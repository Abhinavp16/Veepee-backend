const fs = require('fs');
const path = require('path');
const { ORDER_CONFIRMATION, ORDER_STATUS } = require('./constants');

// Order receipt PDF (A4), written directly so no PDF library is needed.
// Ported from the Laxmi Agro receipt; Oxon orders have no packs or variants.

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;

// Shown when the settings have no GSTIN saved yet; an empty value hides it.
const DEFAULT_GSTIN = '22AAXFV7313A1Z8';

const formatDateTime = (value) => {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(new Date(value));
  } catch (error) {
    return new Date(value).toLocaleString('en-IN');
  }
};

const formatCurrency = (value) => `Rs. ${new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0))}`;

// "9,200.00" (the Rs. sits in the column heading).
const formatAmount = (value) => new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

/** Receipts exist once the shop has confirmed the order (and not cancelled it). */
const isReceiptAvailable = (order = {}) => order.status !== ORDER_STATUS.CANCELLED
  && order.confirmationStatus !== ORDER_CONFIRMATION.PENDING
  && order.confirmationStatus !== ORDER_CONFIRMATION.REJECTED;

const paymentLabel = (status) => {
  if (status === ORDER_STATUS.PENDING_PAYMENT) return 'Awaiting payment';
  if (status === ORDER_STATUS.PAYMENT_UPLOADED) return 'Payment under review';
  return 'Paid';
};

// Helvetica glyph widths (per 1000 em) for the characters in amounts,
// so numbers can be right-aligned. Other characters use an average width.
const HELVETICA_WIDTHS = {
  regular: { digit: 556, ' ': 278, '.': 278, ',': 278, '-': 333, '/': 278, R: 722, s: 500, '(': 333, ')': 333 },
  bold: { digit: 556, ' ': 278, '.': 278, ',': 278, '-': 333, '/': 278, R: 722, s: 556, '(': 333, ')': 333 },
};
const textWidth = (text, size, bold = false) => {
  const table = bold ? HELVETICA_WIDTHS.bold : HELVETICA_WIDTHS.regular;
  let units = 0;
  for (const char of String(text)) {
    units += /\d/.test(char) ? table.digit : (table[char] ?? (bold ? 611 : 556));
  }
  return (units / 1000) * size;
};

const escapePdfText = (value = '') => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')
  .replace(/[^\x20-\x7E]/g, '?');

const wrapText = (text, maxChars) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['-'];

  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
      continue;
    }

    let remaining = word;
    while (remaining.length > maxChars) {
      lines.push(remaining.slice(0, maxChars - 1));
      remaining = remaining.slice(maxChars - 1);
    }
    current = remaining;
  }

  if (current) lines.push(current);
  return lines;
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

// Faint logo in the middle of every page (JPEG, 600x600 px).
const WATERMARK_PATH = path.join(__dirname, '../assets/receipt-watermark.jpg');
const WATERMARK_SIZE = 600;
const WATERMARK_DRAW = 300; // points
const WATERMARK_OPACITY = 0.07;
let watermarkJpeg;
const loadWatermark = () => {
  if (watermarkJpeg === undefined) {
    try {
      watermarkJpeg = fs.readFileSync(WATERMARK_PATH);
    } catch {
      watermarkJpeg = null;
    }
  }
  return watermarkJpeg;
};

const createPdfBuffer = (pages) => {
  const objects = [];
  const pushObject = (content) => {
    objects.push(Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1'));
    return objects.length;
  };

  const catalogId = pushObject('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesId = pushObject('');
  const regularFontId = pushObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = pushObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const jpeg = loadWatermark();
  let imageResources = '';
  let watermarkCommands = '';
  if (jpeg) {
    const imageId = pushObject(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${WATERMARK_SIZE} /Height ${WATERMARK_SIZE} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]));
    const stateId = pushObject(`<< /Type /ExtGState /ca ${WATERMARK_OPACITY} /CA ${WATERMARK_OPACITY} >>`);
    imageResources = ` /XObject << /Wm ${imageId} 0 R >> /ExtGState << /GSw ${stateId} 0 R >>`;
    const x = ((PAGE_WIDTH - WATERMARK_DRAW) / 2).toFixed(2);
    const y = ((PAGE_HEIGHT - WATERMARK_DRAW) / 2).toFixed(2);
    watermarkCommands = `q /GSw gs ${WATERMARK_DRAW} 0 0 ${WATERMARK_DRAW} ${x} ${y} cm /Wm Do Q\n`;
  }

  const pageObjectIds = [];
  for (const pageContent of pages) {
    const content = `${watermarkCommands}${pageContent}`;
    const stream = Buffer.from(content, 'latin1');
    const contentId = pushObject(`<< /Length ${stream.length} >>\nstream\n${content}\nendstream`);
    const pageId = pushObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >>${imageResources} >> ` +
      `/Contents ${contentId} 0 R >>`
    );
    pageObjectIds.push(pageId);
  }

  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`,
    'latin1',
  );

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let length = chunks[0].length;
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    length += chunk.length;
  });

  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    trailer += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${length}\n%%EOF`;
  chunks.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(chunks);
};


const createOrderReceiptPdfBuffer = async ({ order, settings }) => {
  const pages = [];
  let commands = [];
  let cursorY = PAGE_HEIGHT - MARGIN;

  const pushPage = () => {
    pages.push(commands.join('\n'));
    commands = [];
    cursorY = PAGE_HEIGHT - MARGIN;
  };

  const ensureSpace = (height) => {
    if (cursorY - height < MARGIN) {
      pushPage();
      drawPageHeader(true);
    }
  };

  const drawText = (text, x, y, { size = 11, font = 'F1' } = {}) => {
    commands.push(`BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`);
  };

  // Text ending at x (numbers in the Total column and totals block).
  const drawTextRight = (text, right, y, { size = 11, font = 'F1' } = {}) => {
    drawText(text, right - textWidth(text, size, font === 'F2'), y, { size, font });
  };

  const drawLine = (x1, y1, x2, y2, width = 0.6) => {
    commands.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  };

  const gstin = (settings?.gstin ?? DEFAULT_GSTIN).trim();

  const drawPageHeader = (continuation = false) => {
    drawText(settings?.businessName || 'Veepee Impex', MARGIN, cursorY, { size: 20, font: 'F2' });
    cursorY -= 18;

    const businessLines = [
      ...wrapText(settings?.businessAddress || '', 95).filter((line) => line !== '-'),
      [
        settings?.businessPhone ? `Phone: ${settings.businessPhone}` : null,
        settings?.businessEmail ? `Email: ${settings.businessEmail}` : null,
      ].filter(Boolean).join(' | '),
      gstin ? `GSTIN: ${gstin}` : '',
    ].filter(Boolean);

    businessLines.forEach((line) => {
      drawText(line, MARGIN, cursorY, { size: 10, font: line.startsWith('GSTIN') ? 'F2' : 'F1' });
      cursorY -= 12;
    });

    cursorY -= 16;
    drawText(continuation ? 'Order Receipt (continued)' : 'Order Receipt', MARGIN, cursorY, { size: 16, font: 'F2' });
    cursorY -= 10;
    drawLine(MARGIN, cursorY, PAGE_WIDTH - MARGIN, cursorY, 1);
    cursorY -= 18;
  };

  drawPageHeader(false);

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
  const blockTop = cursorY;

  metaPairs.forEach(([label, value]) => {
    drawText(`${label}:`, MARGIN, cursorY, { size: 11, font: 'F2' });
    wrapText(value, 30).forEach((line) => {
      drawText(line, MARGIN + 95, cursorY, { size: 11 });
      cursorY -= 14;
    });
  });
  const metaBottom = cursorY;

  cursorY = blockTop;
  drawText('Shipping Address', addressX, cursorY, { size: 12, font: 'F2' });
  cursorY -= 15;
  addressLines.forEach((line) => {
    drawText(line, addressX, cursorY, { size: 10 });
    cursorY -= 12;
  });
  cursorY = Math.min(cursorY, metaBottom);

  cursorY -= 6;
  ensureSpace(26);
  drawLine(MARGIN, cursorY, PAGE_WIDTH - MARGIN, cursorY, 0.8);
  cursorY -= 16;
  drawText('Product', MARGIN, cursorY, { size: 11, font: 'F2' });
  drawText('Qty', MARGIN + 290, cursorY, { size: 11, font: 'F2' });
  drawText('Rate (Rs.)', MARGIN + 345, cursorY, { size: 11, font: 'F2' });
  drawTextRight('Total (Rs.)', PAGE_WIDTH - MARGIN, cursorY, { size: 11, font: 'F2' });
  cursorY -= 10;
  drawLine(MARGIN, cursorY, PAGE_WIDTH - MARGIN, cursorY, 0.8);
  cursorY -= 14;

  for (const [index, item] of (order.items || []).entries()) {
    const productLines = [
      ...wrapText(item.productSnapshot?.name || `Item ${index + 1}`, 42),
      ...(item.productSnapshot?.sku ? [`SKU: ${item.productSnapshot.sku}`] : []),
    ];

    const rowHeight = Math.max(28, (productLines.length * 12) + 12);
    ensureSpace(rowHeight + 12);

    drawText(productLines[0], MARGIN, cursorY, { size: 10, font: 'F2' });
    drawText(String(item.quantity || 0), MARGIN + 290, cursorY, { size: 10 });
    drawText(formatAmount(item.pricePerUnit), MARGIN + 345, cursorY, { size: 10 });
    drawTextRight(formatAmount(item.totalPrice), PAGE_WIDTH - MARGIN, cursorY, { size: 10 });

    let lineY = cursorY - 12;
    for (let lineIndex = 1; lineIndex < productLines.length; lineIndex += 1) {
      drawText(productLines[lineIndex], MARGIN, lineY, { size: 9 });
      lineY -= 11;
    }

    cursorY -= rowHeight;
    drawLine(MARGIN, cursorY + 13, PAGE_WIDTH - MARGIN, cursorY + 13, 0.35);
  }

  cursorY -= 8;
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
    drawText(label, MARGIN + 300, cursorY, { size: grand ? 12 : 10, font: grand ? 'F2' : 'F1' });
    drawTextRight(value, PAGE_WIDTH - MARGIN, cursorY, { size: grand ? 12 : 10, font: grand ? 'F2' : 'F1' });
    cursorY -= index === totals.length - 1 ? 18 : 14;
  });

  if (order.customerNote) {
    ensureSpace(24);
    drawText('Customer Note', MARGIN, cursorY, { size: 11, font: 'F2' });
    cursorY -= 14;
    wrapText(order.customerNote, 78).forEach((line) => {
      ensureSpace(12);
      drawText(line, MARGIN, cursorY, { size: 10 });
      cursorY -= 12;
    });
  }

  ensureSpace(42);
  cursorY -= 14;
  drawText('This is a computer-generated receipt. Thank you for shopping with OXON.', MARGIN, cursorY, { size: 9 });
  cursorY -= 12;
  const contact = settings?.businessPhone ? ` at ${settings.businessPhone}` : '';
  drawText(`For the GST original, please contact us${contact}.`, MARGIN, cursorY, { size: 9, font: 'F2' });

  if (commands.length > 0) {
    pushPage();
  }

  return createPdfBuffer(pages);
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
const sendOrderReceipt = async (res, order, settings) => {
  const buffer = await createOrderReceiptPdfBuffer({ order, settings });
  const fileName = receiptFileName(order);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.setHeader('X-Receipt-Filename', encodeURIComponent(fileName));
  res.setHeader('Access-Control-Expose-Headers', 'X-Receipt-Filename');
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
};

module.exports = {
  DEFAULT_GSTIN,
  createOrderReceiptPdfBuffer,
  isReceiptAvailable,
  receiptFileName,
  sendOrderReceipt,
};
