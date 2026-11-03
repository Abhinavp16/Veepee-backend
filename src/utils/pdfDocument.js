const fs = require('fs');
const path = require('path');

// A4 PDF documents (order receipts, price requests), written directly so no
// PDF library is needed: Helvetica text, lines and a faint logo watermark.

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

/**
 * Writes a document top to bottom. Every page starts with the business
 * header (name, address, phone, GSTIN) and [title]; `w.y` is where the next
 * line goes, and `ensureSpace` starts a new page when it doesn't fit.
 */
const createPageWriter = ({ settings, title }) => {
  const pages = [];
  let commands = [];

  const w = {
    y: PAGE_HEIGHT - MARGIN,
    PAGE_WIDTH,
    MARGIN,
    right: PAGE_WIDTH - MARGIN,
  };

  w.drawText = (text, x, y, { size = 11, font = 'F1' } = {}) => {
    commands.push(`BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`);
  };

  // Text ending at x (numbers in amount columns and totals).
  w.drawTextRight = (text, right, y, { size = 11, font = 'F1' } = {}) => {
    w.drawText(text, right - textWidth(text, size, font === 'F2'), y, { size, font });
  };

  w.drawLine = (x1, y1, x2, y2, width = 0.6) => {
    commands.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  };

  const gstin = (settings?.gstin ?? DEFAULT_GSTIN).trim();

  const drawPageHeader = (continuation = false) => {
    w.drawText(settings?.businessName || 'Veepee Impex', MARGIN, w.y, { size: 20, font: 'F2' });
    w.y -= 18;

    const businessLines = [
      ...wrapText(settings?.businessAddress || '', 95).filter((line) => line !== '-'),
      [
        settings?.businessPhone ? `Phone: ${settings.businessPhone}` : null,
        settings?.businessEmail ? `Email: ${settings.businessEmail}` : null,
      ].filter(Boolean).join(' | '),
      gstin ? `GSTIN: ${gstin}` : '',
    ].filter(Boolean);

    businessLines.forEach((line) => {
      w.drawText(line, MARGIN, w.y, { size: 10, font: line.startsWith('GSTIN') ? 'F2' : 'F1' });
      w.y -= 12;
    });

    w.y -= 16;
    w.drawText(continuation ? `${title} (continued)` : title, MARGIN, w.y, { size: 16, font: 'F2' });
    w.y -= 10;
    w.drawLine(MARGIN, w.y, PAGE_WIDTH - MARGIN, w.y, 1);
    w.y -= 18;
  };

  const pushPage = () => {
    pages.push(commands.join('\n'));
    commands = [];
    w.y = PAGE_HEIGHT - MARGIN;
  };

  w.ensureSpace = (height) => {
    if (w.y - height < MARGIN) {
      pushPage();
      drawPageHeader(true);
    }
  };

  /** The finished PDF. */
  w.finish = () => {
    if (commands.length > 0) pushPage();
    return createPdfBuffer(pages);
  };

  drawPageHeader(false);
  return w;
};

/** "Ravi-Traders-ORD-2026-9001.pdf" from its parts (letters, digits, dashes). */
const pdfFileName = (...parts) => {
  const clean = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return `${parts.map(clean).filter(Boolean).join('-') || 'Document'}.pdf`;
};

/** Sends a PDF to open in the browser; the file name is also in X-Receipt-Filename. */
const sendPdf = (res, buffer, fileName) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.setHeader('X-Receipt-Filename', encodeURIComponent(fileName));
  res.setHeader('Access-Control-Expose-Headers', 'X-Receipt-Filename');
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
};

module.exports = {
  PAGE_WIDTH,
  MARGIN,
  DEFAULT_GSTIN,
  formatDateTime,
  formatCurrency,
  formatAmount,
  wrapText,
  createPageWriter,
  pdfFileName,
  sendPdf,
};
