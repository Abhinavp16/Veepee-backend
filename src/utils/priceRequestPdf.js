const {
  formatDateTime,
  formatCurrency,
  formatAmount,
  wrapText,
  createPageWriter,
  pdfFileName,
  sendPdf,
} = require('./pdfDocument');

/**
 * A wholesaler's price request (one negotiation, or every line of a
 * requirement): what they asked for, at what price. Opened by OXON staff
 * from the WhatsApp message; it is not a bill.
 */
const createPriceRequestPdfBuffer = ({ members, wholesaler, settings }) => {
  const w = createPageWriter({ settings, title: 'Price Request' });
  const { MARGIN, PAGE_WIDTH } = w;
  const { drawText, drawTextRight, drawLine, ensureSpace } = w;
  const first = members[0];

  const metaPairs = [
    ['Request Number', first.requestGroup?.number || first.negotiationNumber || '-'],
    ['Date', formatDateTime(first.createdAt)],
    ...(first.expiresAt ? [['Valid Until', formatDateTime(first.expiresAt)]] : []),
    ['Wholesaler', wholesaler?.name || '-'],
    ...(wholesaler?.businessInfo?.businessName ? [['Business', wholesaler.businessInfo.businessName]] : []),
    ['Phone', wholesaler?.phone || '-'],
    ...(wholesaler?.businessInfo?.gstNumber ? [['GSTIN', wholesaler.businessInfo.gstNumber]] : []),
  ];
  metaPairs.forEach(([label, value]) => {
    wrapText(value, 60).forEach((line, index) => {
      ensureSpace(14);
      if (index === 0) drawText(`${label}:`, MARGIN, w.y, { size: 11, font: 'F2' });
      drawText(line, MARGIN + 110, w.y, { size: 11 });
      w.y -= 14;
    });
  });

  // Product | Qty | List | Asked | Total
  const columns = { qty: MARGIN + 250, list: MARGIN + 300, asked: MARGIN + 380 };
  w.y -= 6;
  ensureSpace(26);
  drawLine(MARGIN, w.y, PAGE_WIDTH - MARGIN, w.y, 0.8);
  w.y -= 16;
  drawText('Product', MARGIN, w.y, { size: 11, font: 'F2' });
  drawText('Qty', columns.qty, w.y, { size: 11, font: 'F2' });
  drawText('List (Rs.)', columns.list, w.y, { size: 11, font: 'F2' });
  drawText('Asked (Rs.)', columns.asked, w.y, { size: 11, font: 'F2' });
  drawTextRight('Total (Rs.)', PAGE_WIDTH - MARGIN, w.y, { size: 11, font: 'F2' });
  w.y -= 10;
  drawLine(MARGIN, w.y, PAGE_WIDTH - MARGIN, w.y, 0.8);
  w.y -= 14;

  members.forEach((n, index) => {
    const productLines = [
      ...wrapText(n.productSnapshot?.name || `Item ${index + 1}`, 38),
      ...(n.productSnapshot?.sku ? [`SKU: ${n.productSnapshot.sku}`] : []),
    ];
    const rowHeight = Math.max(28, (productLines.length * 12) + 12);
    ensureSpace(rowHeight + 12);

    drawText(productLines[0], MARGIN, w.y, { size: 10, font: 'F2' });
    drawText(String(n.requestedQuantity || 0), columns.qty, w.y, { size: 10 });
    drawText(formatAmount(n.productSnapshot?.price), columns.list, w.y, { size: 10 });
    drawText(formatAmount(n.requestedPricePerUnit), columns.asked, w.y, { size: 10, font: 'F2' });
    drawTextRight(formatAmount(n.requestedTotalPrice), PAGE_WIDTH - MARGIN, w.y, { size: 10 });

    let lineY = w.y - 12;
    for (let lineIndex = 1; lineIndex < productLines.length; lineIndex += 1) {
      drawText(productLines[lineIndex], MARGIN, lineY, { size: 9 });
      lineY -= 11;
    }
    w.y -= rowHeight;
    drawLine(MARGIN, w.y + 13, PAGE_WIDTH - MARGIN, w.y + 13, 0.35);
  });

  const listTotal = members.reduce((sum, n) => sum + (Number(n.productSnapshot?.price || 0) * Number(n.requestedQuantity || 0)), 0);
  const askedTotal = members.reduce((sum, n) => sum + Number(n.requestedTotalPrice || 0), 0);
  w.y -= 8;
  [['At list price', formatCurrency(listTotal)], ['Total Asked', formatCurrency(askedTotal)]].forEach(([label, value], index, all) => {
    ensureSpace(16);
    const last = index === all.length - 1;
    drawText(label, MARGIN + 300, w.y, { size: last ? 12 : 10, font: last ? 'F2' : 'F1' });
    drawTextRight(value, PAGE_WIDTH - MARGIN, w.y, { size: last ? 12 : 10, font: last ? 'F2' : 'F1' });
    w.y -= last ? 18 : 14;
  });

  if (first.message) {
    ensureSpace(24);
    drawText('Wholesaler Note', MARGIN, w.y, { size: 11, font: 'F2' });
    w.y -= 14;
    wrapText(first.message, 78).forEach((line) => {
      ensureSpace(12);
      drawText(line, MARGIN, w.y, { size: 10 });
      w.y -= 12;
    });
  }

  ensureSpace(30);
  w.y -= 14;
  drawText('Price request sent from the OXON app. Prices are what the wholesaler asked for; this is not a bill.', MARGIN, w.y, { size: 9, font: 'F2' });

  return w.finish();
};

const sendPriceRequestPdf = (res, { members, wholesaler, settings }) => {
  const buffer = createPriceRequestPdfBuffer({ members, wholesaler, settings });
  const first = members[0];
  sendPdf(res, buffer, pdfFileName(
    wholesaler?.businessInfo?.businessName || wholesaler?.name,
    first.requestGroup?.number || first.negotiationNumber,
  ));
};

module.exports = { createPriceRequestPdfBuffer, sendPriceRequestPdf };
