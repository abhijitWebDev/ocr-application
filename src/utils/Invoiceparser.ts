// src/utils/invoiceParser.ts

const GEMINI_API_KEY = process.env.EXPO_PUBLIC_VISION_KEY || '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-002:generateContent?key=${GEMINI_API_KEY}`;

async function extractItemsWithGemini(rawText: string): Promise<LineItem[]> {
  if (!GEMINI_API_KEY) return [];
  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Extract all line items from this invoice OCR text. Return ONLY a valid JSON array with no markdown, no code fences, no explanation.
Each object must have these exact keys:
- srNo: number (serial/line number, start from 1 if missing)
- description: string (product/service name)
- hsnCode: string or null
- quantity: number or null
- unit: string or null (e.g. "PCS", "KG", "NOS")
- rate: number or null (unit price)
- netAmount: number (total for this line, 0 if unknown)

Invoice text:
${rawText.slice(0, 6000)}`,
              },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as Array<{
      srNo: number;
      description: string;
      hsnCode: string | null;
      quantity: number | null;
      unit: string | null;
      rate: number | null;
      netAmount: number;
    }>;
    return parsed.map((p, idx) => ({
      srNo: p.srNo ?? idx + 1,
      description: p.description ?? '',
      hsnCode: p.hsnCode ?? null,
      quantity: p.quantity != null ? { value: p.quantity, unit: p.unit ?? null } : null,
      rate: p.rate ?? null,
      per: null,
      netAmount: p.netAmount ?? 0,
    }));
  } catch {
    return [];
  }
}

// ── Target JSON schema ────────────────────────────────────────────────────────

export interface InvoiceItem {
  itemNo: number;
  lineNo: number;
  description: string;
  hsnCode: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  discount: number | null;
  tax: number | null;
  totalAmount: number;
}

export interface TaxEntry {
  rate: number;
  amount: number;
}

export interface ParsedInvoice {
  // ── app internals ──
  id: string;
  scannedAt: string;
  imageUri?: string;
  invoiceType: string;
  validation?: {
    isValid: boolean;
    issues: string[];
    confidence: { score: number };
  };

  // ── exported JSON fields ──
  invoiceNo: string | null;
  date: string | null;
  eWayBillNo: string | null;
  vendor: {
    name: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    taxId: string | null;
    udyamNo: string | null;
  };
  customer: {
    name: string | null;
    address: string | null;
    gstin: string | null;
    pan: string | null;
    phone: string | null;
    email: string | null;
  };
  shipTo: {
    name: string | null;
    address: string | null;
  } | null;
  items: InvoiceItem[];
  totals: {
    subtotal: number | null;
    taxAmount: number | null;
    discountAmount: number | null;
    roundOff: number | null;
    tdsAmount: number | null;
    grandTotal: number | null;
    currency: string;
  };
  dispatch: {
    transport: string | null;
    motorVehicleNo: string | null;
    lrNumber: string | null;
  } | null;
  paymentTerms: string | null;
  notes: string | null;
  rawText: string;

  // ── kept for result.tsx / history.tsx compatibility ──
  invoiceNumber: string | null;
  gstNumbers: string[];
  bankDetails: {
    bankName: string | null;
    accountNumber: string | null;
    ifscCode: string | null;
  };
  taxes: {
    cgst: TaxEntry | null;
    sgst: TaxEntry | null;
    igst: TaxEntry | null;
  };
  amountInWords: string | null;
  transport: string | null;
  lrNumber: string | null;
}

// ── Internal line item shape (used by extractLineItems, mapped to InvoiceItem in parseInvoice) ──
interface LineItem {
  srNo: number;
  description: string;
  hsnCode: string | null;
  quantity: { value: number; unit: string | null } | null;
  rate: number | null;
  per: string | null;
  netAmount: number;
}

function generateId() {
  return `inv_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

/** Strip ₹, Rs., commas, and spaces, then parse as float. */
function parseIndianNumber(s: string): number {
  return parseFloat(s.replace(/[₹,\s]/g, '').replace(/[^\d.]/g, '')) || 0;
}

export async function parseInvoice(rawText: string): Promise<ParsedInvoice> {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const fullText = rawText.toUpperCase();

  const vendorRaw = extractVendor(lines);
  const customerRaw = extractCustomer(lines);
  const dateRaw = extractDate(lines);
  const invoiceNo = extractInvoiceNumber(lines);
  const eWayBillNo = extractEWayBillNo(lines);
  const taxes = extractTaxes(lines);
  const totalsRaw = extractTotals(lines);
  const contact = extractContactDetails(rawText);
  const bank = extractBankDetails(lines);
  const gstNums = extractGSTNumbers(rawText);
  let lineItemsRaw = extractLineItems(lines);
  if (lineItemsRaw.length === 0) {
    lineItemsRaw = await extractItemsWithGemini(rawText);
  }
  const amtWords = extractAmountInWords(lines);
  const transport = extractTransport(lines);
  const lrNumber = extractLRNumber(lines);
  const motorVehicleNo = extractMotorVehicleNo(lines);
  const pan = extractPANNumber(rawText);
  const udyamNo = extractUdyamNo(rawText);
  const shipTo = extractShipTo(lines);
  const roundOff = extractRoundOff(lines);
  const tdsAmount = extractTDS(lines);

  // ── vendor address ──────────────────────────────────────────────────────────
  const vendorAddrLines = extractVendorAddress(lines);

  // ── taxAmount = CGST + SGST + IGST ─────────────────────────────────────────
  const taxAmount =
    (taxes.cgst?.amount ?? 0) +
      (taxes.sgst?.amount ?? 0) +
      (taxes.igst?.amount ?? 0) || null;

  // ── notes ───────────────────────────────────────────────────────────────────
  const notesParts: string[] = [];
  const po = extractPONumber(lines);
  const poDate = extractPODate(lines);
  const pos = extractPlaceOfSupply(lines);
  if (po) notesParts.push(`PO No.: ${po}`);
  if (poDate) notesParts.push(`PO Date: ${poDate}`);
  if (pos) notesParts.push(`Place of Supply: ${pos}`);
  if (taxes.cgst)
    notesParts.push(
      `CGST @${taxes.cgst.rate}%: ${formatINR(taxes.cgst.amount)}`,
    );
  if (taxes.sgst)
    notesParts.push(
      `SGST @${taxes.sgst.rate}%: ${formatINR(taxes.sgst.amount)}`,
    );
  if (taxes.igst)
    notesParts.push(
      `IGST @${taxes.igst.rate}%: ${formatINR(taxes.igst.amount)}`,
    );
  if (amtWords) notesParts.push(`Total Amount (in words): ${amtWords}`);
  if (bank.bankName)
    notesParts.push(
      `Bank Details: Name: ${bank.bankName}` +
        (bank.ifscCode ? `. IFSC Code: ${bank.ifscCode}` : '') +
        (bank.accountNumber ? `. Account No: ${bank.accountNumber}` : ''),
    );

  // ── map line items ──────────────────────────────────────────────────────────
  const items: InvoiceItem[] = lineItemsRaw.map((li, idx) => ({
    itemNo: idx + 1,
    lineNo: li.srNo,
    description: li.description,
    hsnCode: li.hsnCode,
    quantity: li.quantity?.value ?? null,
    unit: li.quantity?.unit ?? null,
    unitPrice: li.rate,
    discount: null,
    tax: null,
    totalAmount: li.netAmount,
  }));

  // ── fix grand total when parser grabbed the subtotal instead ────────────────
  // In cell-by-cell OCR invoices the final total is often absent as a standalone
  // number; Fallback 2 then picks the largest number it can find, which is
  // usually the taxable subtotal.  Detect this by comparing with the item sum.
  const itemSum = items.reduce((s, it) => s + (it.totalAmount ?? 0), 0);
  let effectiveGrandTotal = totalsRaw.grandTotal;
  let effectiveSubtotal = totalsRaw.subtotal;
  if (
    effectiveGrandTotal != null &&
    taxAmount != null &&
    Math.abs(effectiveGrandTotal - itemSum) < 1
  ) {
    // grandTotal == subtotal — compute the real total
    effectiveSubtotal = effectiveGrandTotal;
    effectiveGrandTotal = effectiveGrandTotal + taxAmount + (roundOff ?? 0);
  }

  return {
    // ── app internals ──
    id: generateId(),
    scannedAt: new Date().toISOString(),
    invoiceType: detectInvoiceType(fullText),

    // ── exported JSON ──
    invoiceNo,
    date: dateRaw.raw,
    eWayBillNo,
    vendor: {
      name: vendorRaw.name || null,
      address: vendorAddrLines.join(', ') || null,
      phone: contact.phones[0] ?? null,
      email: contact.emails[0] ?? null,
      taxId: gstNums[0] ? `GSTIN: ${gstNums[0]}` : null,
      udyamNo,
    },
    customer: {
      name: customerRaw.name,
      address: customerRaw.addressLines.join(', ') || null,
      gstin: customerRaw.gstNumber,
      pan,
      phone: null,
      email: null,
    },
    shipTo,
    items,
    totals: {
      subtotal: effectiveSubtotal,
      taxAmount: taxAmount ?? totalsRaw.taxAmount,
      discountAmount: null,
      roundOff,
      tdsAmount,
      grandTotal: effectiveGrandTotal,
      currency: 'INR',
    },
    dispatch: {
      transport,
      motorVehicleNo,
      lrNumber,
    },
    paymentTerms: extractPaymentTerms(lines),
    notes: notesParts.length > 0 ? notesParts.join('. ') : null,
    rawText,

    // ── compatibility fields ──
    invoiceNumber: invoiceNo,
    gstNumbers: gstNums,
    bankDetails: bank,
    taxes,
    amountInWords: amtWords,
    transport,
    lrNumber,
  };
}

// ── FIX 1: Vendor ─────────────────────────────────────────────────────────────
// Added PRIVATE and LIMITED (full words, not just PVT/LTD abbreviations).
// Lines that appear at the top of Indian e-invoices BEFORE the vendor block.
// Skip them so we don't mistake "(ORIGINAL FOR RECIPIENT)" etc. for the vendor.
const VENDOR_HEADER_SKIP =
  /^\(|^e-?Invoice\b|^IRN\b|^Ack\s|^Tax\s+Invoice\b|ORIGINAL\s+FOR|RECIPIENT|^E\s*&\s*O|^This\s+is\s+a/i;

function extractVendor(lines: string[]) {
  for (const line of lines.slice(0, 20)) {
    const t = line.trim();
    if (t.length < 6) continue;
    if (VENDOR_HEADER_SKIP.test(t)) continue;

    // Prefer explicit company-type keywords
    if (
      /PRIVATE|LIMITED|PVT|LTD|TRADE|ENTERPRISES|CORP|INDUSTRIES|SERVICES|SOLUTIONS/i.test(
        t,
      )
    ) {
      return { name: t, raw: line };
    }
    // All-caps word-only line (no colon, no leading digit, no parentheses)
    if (
      t === t.toUpperCase() &&
      t.length > 8 &&
      /[A-Z]/.test(t) &&
      !t.includes(':') &&
      !/^\d/.test(t) &&
      !/[()[\]{}]/.test(t)
    ) {
      return { name: t, raw: line };
    }
  }
  return { name: lines[0] || 'Unknown Vendor', raw: lines[0] || '' };
}

// ── FIX 2: Invoice number ──────────────────────────────────────────────────────
// Many Indian invoices put the label ("Invoice No.") on one line and the value
// on the next.  We now look ahead to lines[i+1] when the label has no inline value.
function extractInvoiceNumber(lines: string[]) {
  const LABEL_RE =
    /(?:TAX\s+INVOICE\s+NO|INVOICE\s+NO|INV\.?\s*NO|BILL\s+NO|INVOICE\s+NUMBER)/i;
  // Value: alphanumeric + hyphens/slashes, must contain at least one digit,
  // minimum 3 chars so we don't grab stray tokens.
  const VALUE_RE = /([A-Z0-9][A-Z0-9\-\/]{2,})/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Case 1 — inline: "Invoice No. : MHI2526000995090"
    const inlineM = line.match(new RegExp(LABEL_RE.source + '[.\\s:#]*' + VALUE_RE.source, 'i'));
    if (inlineM && /\d/.test(inlineM[1])) return inlineM[1].trim();

    // Case 2 — label at end of line (two-column PDF layout):
    //   "Subscriber Name:    Invoice No:"  → value is on the next line
    if (LABEL_RE.test(line) && lines[i + 1]) {
      // Only treat as label-only if no value follows the label on this line
      const afterLabel = line.replace(LABEL_RE, '').replace(/[.\s:#]*/g, '').trim();
      if (!afterLabel || !/\d/.test(afterLabel)) {
        const next = lines[i + 1].match(VALUE_RE);
        if (next && /\d/.test(next[1])) return next[1].trim();
      }
    }
  }

  // Fallback: first long alphanumeric token (≥6 chars with digits) near "invoice"
  const idx = lines.findIndex((l) => /invoice/i.test(l));
  if (idx !== -1) {
    for (let i = idx; i < Math.min(idx + 5, lines.length); i++) {
      const m = lines[i].match(/\b([A-Z]{1,4}\d{6,}|\d{6,})\b/i);
      if (m) return m[1];
    }
  }
  return null;
}

// ── FIX 3: Date — handle 2-digit year ─────────────────────────────────────────
function extractDate(lines: string[]) {
  // Month-name patterns work on any line
  const monthPatterns = [
    /(\d{1,2}[\s\-\/](?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[\s\-\/]\d{2,4})/i,
    /DATE\s*[:\-]?\s*(\d{1,2}[\s\-\/]\w+[\s\-\/]\d{2,4})/i,
  ];
  // Numeric pattern: only match dd/mm/yyyy (4-digit year required to avoid
  // matching "25-26" from invoice numbers like "JDKPL/25-26/811")
  const numericPattern = /(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{4})/;

  for (const line of lines) {
    // Skip lines that look like invoice/PO numbers (contain letters + numbers with slashes)
    if (/[A-Z]{2,}.*\/.*\//.test(line)) continue;

    for (const p of monthPatterns) {
      const m = line.match(p);
      if (m) return { raw: m[1].trim(), parsed: parseDate(m[1]) };
    }
    const m = line.match(numericPattern);
    if (m) return { raw: m[1].trim(), parsed: parseDate(m[1]) };
  }
  return { raw: null, parsed: null };
}

function parseDate(s: string): string | null {
  const months: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  const m = s.trim().match(/(\d{1,2})[\s\-\/]+([A-Z]{3})[\s\-\/]+(\d{2,4})/i);
  if (m) {
    const mo = months[m[2].toLowerCase()];
    if (mo !== undefined) {
      // FIX: treat 2-digit years as 2000+
      let year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      return new Date(year, mo, parseInt(m[1], 10)).toISOString();
    }
  }
  return null;
}

// ── FIX 4: Customer — handle "Buyer (Bill to)" / "Consignee (Ship to)" ────────
function extractCustomer(lines: string[]) {
  // Prefer "Buyer (Bill to)" over "Consignee (Ship to)" so we get the billing address.
  let idx = lines.findIndex((l) => /Buyer\s*\(?\s*Bill/i.test(l));
  if (idx === -1) idx = lines.findIndex((l) => /^BILL\s+TO/i.test(l));
  if (idx === -1) idx = lines.findIndex((l) => /Consignee/i.test(l));
  if (idx === -1) idx = lines.findIndex((l) => /^M\/[Ss]|^TO\s/i.test(l));
  // Telecom / utility bills use "Subscriber Name", "Account Holder", "Customer Name"
  if (idx === -1) idx = lines.findIndex((l) => /Subscriber\s+Name|Account\s+Holder|Customer\s+Name|Account\s+Name/i.test(l));

  if (idx !== -1) {
    const chunk: string[] = [];
    for (let i = idx + 1; i < Math.min(idx + 12, lines.length); i++) {
      const l = lines[i];
      // Stop at known section dividers or right-column metadata that OCR
      // can merge into the address block on multi-column invoices.
      if (
        /GSTIN|GST\s*NO|TAX\s*INVOICE|^DATE\b|TRANSPORT|INVOICE\s*NO|^IRN\b|Buyer\s*\(?\s*Bill|Consignee|MODE.*PAYMENT|OTHER\s*REFERENCES|DELIVERY\s*NOTE|DISPATCHED|^DATED\b|Delivery\s+Note\s+Date|Motor\s+Vehicle/i.test(
          l,
        )
      )
        break;
      chunk.push(l);
    }
    const gstLine = chunk.find((l) => /GSTIN|GST\s*(?:NO|NUMBER)/i.test(l));
    const gstM = gstLine?.match(
      /(?:GSTIN\/UIN|GSTIN|GST\s*(?:NO|NUMBER))[.\s:]*([A-Z0-9]{15})/i,
    );
    return {
      name: chunk[0]?.replace(/^M\/[Ss]\s+/i, '').trim() || null,
      addressLines: chunk
        .slice(1)
        .filter((l) => !/GSTIN|GST\s*(?:NO|NUMBER)|State\s*Name/i.test(l)),
      gstNumber: gstM?.[1] || null,
      raw: chunk.join('\n'),
    };
  }
  return { name: null, addressLines: [], gstNumber: null, raw: null };
}

// ── FIX 9: Transport — handle "Dispatched through" / "Dispatched by" ──────────
function extractTransport(lines: string[]) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Same-line: "Transport : XYZ" or "Dispatched through XYZ"
    const m = l.match(
      /(?:TRANSPORT|DISPATCHED\s+(?:THROUGH|BY))\s*[:\-]?\s*(.+)/i,
    );
    if (m && m[1].trim().length > 0 && !/^\s*$/.test(m[1])) {
      return m[1].trim();
    }
    // Label-only line → value on the next non-empty line
    if (/^(?:Dispatched\s+through|Transport)\s*$/i.test(l) && lines[i + 1]) {
      return lines[i + 1].trim();
    }
  }
  return null;
}

function extractLRNumber(lines: string[]) {
  for (const l of lines) {
    const m = l.match(
      /(?:L\.?R\.?\s*NO\.?|BILL\s+OF\s+LADING[^\d]*)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\-]{1,})/i,
    );
    if (m) {
      const val = m[1].trim();
      // Reject OCR box-border artifacts (single char/digit or all zeros)
      if (val.length >= 2 && !/^0+$/.test(val)) return val;
    }
  }
  return null;
}

function extractGSTNumbers(rawText: string) {
  const p = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1})\b/gi;
  return [...new Set([...rawText.matchAll(p)].map((m) => m[1].toUpperCase()))];
}

function extractPANNumber(rawText: string) {
  const m = rawText.match(
    /PAN\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([A-Z]{5}\d{4}[A-Z]{1})/i,
  );
  return m ? m[1].toUpperCase() : null;
}

// ── FIX 8: Bank — extract structured name + robust IFSC scan ──────────────────
// Problem: "Branch & IFS Code : Boisar & TMBL0000256" — IFSC sits after "Boisar & "
// Fix: scan the whole line for the IFSC pattern [A-Z]{4}0[A-Z0-9]{6} anywhere.
function extractBankDetails(lines: string[]) {
  const b: {
    bankName: string | null;
    accountNumber: string | null;
    ifscCode: string | null;
  } = { bankName: null, accountNumber: null, ifscCode: null };

  for (const l of lines) {
    // Bank name: prefer explicit "Bank Name : ..." label
    if (/BANK\s*NAME\s*[:\-]/i.test(l) && !b.bankName) {
      const m = l.match(/BANK\s*NAME\s*[:\-]\s*(.+)/i);
      if (m) b.bankName = m[1].trim();
    } else if (/BANK/i.test(l) && !b.bankName) {
      // Fallback: use the whole line (strip label prefix if present)
      b.bankName = l.replace(/^.*?:\s*/, '').trim() || l.trim();
    }

    // Account number
    if (!b.accountNumber) {
      const ac = l.match(/A\/C\s*(?:NO\.?)?\s*[:\-]?\s*([\d]+)/i);
      if (ac) b.accountNumber = ac[1];
    }

    // IFSC: scan for the 11-char pattern anywhere in the line
    // Handles "Boisar & TMBL0000256" → extracts TMBL0000256
    if (!b.ifscCode) {
      const ifsc = l.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/i);
      if (ifsc) b.ifscCode = ifsc[1].toUpperCase();
    }
  }
  return b;
}

// ── FIX 5: Line items — decimal quantities, flexible column layout ─────────────
// Changed quantity group from `[\d,]+` to `[\d,]+(?:\.\d+)?` to capture 541.800.
// Added an optional "package count + unit" prefix (e.g. "22 BAG") before description.
function extractLineItems(lines: string[]): LineItem[] {
  const items: LineItem[] = [];
  let inSection = false;
  let headerPassed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    // ── Header detection ──────────────────────────────────────────────────
    // Format 1: single-line header — S.NO/SR.NO/SL.NO + qty/rate/amount/price
    if (
      /S[LRI]?\.?\s*NO|DESCRIPTION|PARTICULARS|HSN/i.test(line) &&
      /QUANTITY|QTY|RATE|AMOUNT|PRICE|VALUE/i.test(line)
    ) {
      headerPassed = true;
      inSection = true;
      continue;
    }
    // Format 2: two-line header (column names split across two rows)
    if (
      /S[LRI]?\.?\s*NO|DESCRIPTION|PARTICULARS|HSN/i.test(line) &&
      i + 1 < lines.length &&
      /QUANTITY|QTY|RATE|AMOUNT|PRICE|VALUE/i.test(lines[i + 1])
    ) {
      headerPassed = true;
      inSection = true;
      i++;
      continue;
    }
    // Format 3: column-block header — "S.NO. ITEMS" alone or with extra cols
    if (
      /^S[LRI]?\.?\s*NO\b.*\bITEMS?\b/i.test(line.trim()) ||
      /^S[LRI]?\.?\s*NO\.?\s*$/i.test(line.trim())
    ) {
      headerPassed = true;
      inSection = true;
      continue;
    }

    if (!headerPassed) continue;

    // ── Section end (^ anchor prevents misfiring on item descriptions) ────
    if (
      /^TOTAL\b|^Output\s+CGST|^Output\s+SGST|^CGST\b|^SGST\b|^IGST\b|^PACKAGING\b|^Amount\s+Chargeable|^Sub\s*[-\s]?Total\b/i.test(
        line,
      )
    ) {
      inSection = false;
    }
    if (!inSection) continue;

    // Pattern A — sr [pkg] desc hsn qty unit rate per amount
    // e.g. "1 22 BAG PLASTIC BAGS 39232990 541.800 Kgs 158.00 Kgs 85,604.40"
    const mA = line.match(
      /^(\d+)\s+(?:\d+\s+[A-Z]+\s+)?(.+?)\s+(\d{4,8})\s+([\d,]+(?:\.\d+)?)\s+([A-Z]+(?:\s+[A-Z]+)?)\s+([\d,]+(?:\.\d+)?)\s+([A-Z]+)\s+([\d,]+(?:\.\d+)?)/i,
    );
    if (mA) {
      items.push({
        srNo: parseInt(mA[1], 10),
        description: mA[2].trim(),
        hsnCode: mA[3],
        quantity: {
          value: parseFloat(mA[4].replace(/,/g, '')),
          unit: mA[5].trim().toUpperCase(),
        },
        rate: parseFloat(mA[6].replace(/,/g, '')),
        per: mA[7].toUpperCase(),
        netAmount: parseFloat(mA[8].replace(/,/g, '')),
      });
      continue;
    }

    // Pattern B — sr desc hsn qty unit rate amount (with HSN, no "per")
    // e.g. "1 USK PM0028 19x14x17.25 48191010 80 PCS 52 4,160"
    const mB = line.match(
      /^(\d+)\s+(.+?)\s+(\d{6,8})\s+([\d,]+(?:\.\d+)?)\s+([A-Z./]+(?:\s+[A-Z./]+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)/i,
    );
    if (mB) {
      items.push({
        srNo: parseInt(mB[1], 10),
        description: mB[2].trim(),
        hsnCode: mB[3],
        quantity: {
          value: parseFloat(mB[4].replace(/,/g, '')),
          unit: mB[5].trim().toUpperCase(),
        },
        rate: parseFloat(mB[6].replace(/,/g, '')),
        per: null,
        netAmount: parseFloat(mB[7].replace(/,/g, '')),
      });
      continue;
    }

    // Pattern B' — sr desc hsn qty unit rate (amount on next OCR line)
    // e.g. "1 USK PM0028 19x14x17.25 48191010 80 PCS 52"
    const mBp = line.match(
      /^(\d+)\s+(.+?)\s+(\d{6,8})\s+([\d,]+(?:\.\d+)?)\s+([A-Z./]+(?:\s+[A-Z./]+)?)\s+([\d,]+(?:\.\d+)?)$/i,
    );
    if (mBp) {
      items.push({
        srNo: parseInt(mBp[1], 10),
        description: mBp[2].trim(),
        hsnCode: mBp[3],
        quantity: {
          value: parseFloat(mBp[4].replace(/,/g, '')),
          unit: mBp[5].trim().toUpperCase(),
        },
        rate: parseFloat(mBp[6].replace(/,/g, '')),
        per: null,
        netAmount: 0,
      });
      continue;
    }

    // Pattern B'' — sr desc hsn qty unit (rate + amount both on next OCR lines)
    // e.g. "2 USK PM0028 19x14x17.25 48191010 830 PCS"
    const mBpp = line.match(
      /^(\d+)\s+(.+?)\s+(\d{6,8})\s+([\d,]+(?:\.\d+)?)\s+([A-Z./]+(?:\s+[A-Z./]+)?)$/i,
    );
    if (mBpp) {
      items.push({
        srNo: parseInt(mBpp[1], 10),
        description: mBpp[2].trim(),
        hsnCode: mBpp[3],
        quantity: {
          value: parseFloat(mBpp[4].replace(/,/g, '')),
          unit: mBpp[5].trim().toUpperCase(),
        },
        rate: null,
        per: null,
        netAmount: 0,
      });
      continue;
    }

    // Pattern C — sr desc qty unit rate amount (no HSN)
    // e.g. "1 Packing Material 80 PCS 52.00 4,160.00"
    const mC = line.match(
      /^(\d+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([A-Z./]+)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/i,
    );
    if (mC && parseFloat(mC[6].replace(/,/g, '')) > 0) {
      items.push({
        srNo: parseInt(mC[1], 10),
        description: mC[2].trim(),
        hsnCode: null,
        quantity: {
          value: parseFloat(mC[3].replace(/,/g, '')),
          unit: mC[4].toUpperCase(),
        },
        rate: parseFloat(mC[5].replace(/,/g, '')),
        per: null,
        netAmount: parseFloat(mC[6].replace(/,/g, '')),
      });
      continue;
    }

    // Pattern C' — sr desc qty rate amount (no unit, no HSN)
    // e.g. "1 Packing Material 80 52.00 4,160.00"
    const mCp = line.match(
      /^(\d+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/i,
    );
    if (mCp) {
      const qty = parseFloat(mCp[3].replace(/,/g, ''));
      const rate = parseFloat(mCp[4].replace(/,/g, ''));
      const amt = parseFloat(mCp[5].replace(/,/g, ''));
      // Sanity: amount should be ≈ qty×rate (within 2%) to avoid misfiring on
      // description lines that happen to end with two numbers.
      if (amt > 0 && Math.abs(qty * rate - amt) / amt < 0.02) {
        items.push({
          srNo: parseInt(mCp[1], 10),
          description: mCp[2].trim(),
          hsnCode: null,
          quantity: { value: qty, unit: null },
          rate,
          per: null,
          netAmount: amt,
        });
        continue;
      }
    }

    // Pattern D — sr desc amount (service / receipt invoices, no qty/rate/HSN)
    // e.g. "1 Professional Consultation Charges 50,000"
    // Guard: reject bare 6–8-digit integers — those are HSN codes, not amounts.
    const mD = line.match(/^(\d+)\s+(.{5,}?)\s+([\d,]+(?:\.\d+)?)$/i);
    if (mD && parseFloat(mD[3].replace(/,/g, '')) > 0 && !/^\d{6,8}$/.test(mD[3].trim())) {
      items.push({
        srNo: parseInt(mD[1], 10),
        description: mD[2].trim(),
        hsnCode: null,
        quantity: null,
        rate: null,
        per: null,
        netAmount: parseFloat(mD[3].replace(/,/g, '')),
      });
      continue;
    }

    // ── Standalone number continuation: fills netAmount for B'/B'' items ──
    // When the OCR emits the amount column on its own line (e.g. "4,160.00"),
    // attach it to the last item if that item still has netAmount === 0.
    if (
      items.length > 0 &&
      items[items.length - 1].netAmount === 0 &&
      /^[\d,]+(?:\.\d+)?$/.test(line.trim())
    ) {
      const val = parseFloat(line.trim().replace(/,/g, ''));
      if (val > 0) {
        items[items.length - 1].netAmount = val;
        continue;
      }
    }

    // ── Description continuation (multi-line descriptions) ────────────────
    if (
      items.length > 0 &&
      !/^\d/.test(line) &&
      !/[\d,]{4,}/.test(line) &&
      line.length > 2
    ) {
      items[items.length - 1].description += ' ' + line.trim();
    }
  }

  // ── Column-block fallback (vertical column layout e.g. JDK invoices) ─────
  if (items.length === 0 && headerPassed) {
    items.push(...parseColumnBlocks(lines));
  }

  return items;
}

function collectBlock(
  lines: string[],
  headerRe: RegExp,
  count: number,
): string[] {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i].trim())) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return [];
  const result: string[] = [];
  for (let i = idx + 1; i < lines.length && result.length < count; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^HSN\/SAC$|^HSN$|^QTY\.?$|^RATE$|^AMOUNT$|^CGST|^SGST|^TOTAL/i.test(l))
      break;
    result.push(l);
  }
  return result;
}

function parseColumnBlocks(lines: string[]): LineItem[] {
  const descLines: Array<{ srNo: number; description: string }> = [];
  let inItems = false;
  let headerLine = '';
  let lastDescLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // Match "S.NO. ITEMS" alone OR with extra column names on same line
    // (e.g. "S.NO. ITEMS HSN QTY. RATE AMOUNT" — combined header format).
    if (
      /^S[LRI]?\.?\s*NO\b.*\bITEMS?\b/i.test(t) ||
      /^S[LRI]?\.?\s*NO\.?\s*$/i.test(t)
    ) {
      inItems = true;
      headerLine = t;
      continue;
    }
    if (!inItems) continue;
    // Only stop once we have ≥1 description: if OCR emits column headers
    // (HSN / QTY. / RATE / AMOUNT) before the numbered rows, skip them
    // without resetting inItems so the real items are still collected.
    if (
      descLines.length > 0 &&
      /^HSN\b|^QTY\.?$|^RATE$|^AMOUNT$/i.test(t)
    ) {
      inItems = false;
      continue;
    }
    const m = line.match(/^(\d+)\s+(.+)/);
    if (m) {
      descLines.push({ srNo: parseInt(m[1], 10), description: m[2].trim() });
      lastDescLineIdx = i;
    }
  }

  if (descLines.length === 0) return [];

  // ── Post-process descLines ──────────────────────────────────────────────────
  // When the OCR emits the S.No and ITEMS columns separately, the only lines
  // that match ^(\d+)\s+(.+) are the QTY-column values (e.g. "80 PCS"),
  // because item descriptions have no leading serial number.  Fix two things:
  //   1. Replace the QTY-derived srNo with a sequential 1…n.
  //   2. Replace the unit-stub description ("PCS") with the real product name
  //      by collecting text-only lines from the ITEMS column (they appear
  //      between the "S.NO. ITEMS" header and the first standalone column header).
  const unitOnlyRe = /^(?:PCS|KGS?|NOS?|KG|BAG|BTL|PKT|BX|CTN|LTR?|MT|TON|QTL|DRUM|SET|EA|EACH|UNIT|SQM|SQF|RMT?)\s*$/i;
  const allDescStubs = descLines.every(d => unitOnlyRe.test(d.description));
  let textDescs: string[] = [];
  if (allDescStubs) {
    // Reassign sequential serial numbers.
    descLines.forEach((d, i) => { d.srNo = i + 1; });

    // Collect text-only product-name lines (no leading digit, not a header keyword)
    // that appear in the items section before the first standalone column header.
    let collectingText = false;
    for (const l of lines) {
      const t = l.trim();
      if (/^S[LRI]?\.?\s*NO\b.*\bITEMS?\b/i.test(t) || /^S[LRI]?\.?\s*NO\.?\s*$/i.test(t)) {
        collectingText = true;
        continue;
      }
      if (!collectingText) continue;
      if (/^HSN\b|^QTY\.?$|^RATE$|^AMOUNT$/i.test(t)) break; // end of items column
      if (!t || /^\d+$/.test(t)) continue;  // skip blank lines and bare S.No digits
      if (/^\d/.test(t)) continue;           // skip lines starting with any digit (QTY etc.)
      textDescs.push(t);
    }
    if (textDescs.length === descLines.length) {
      descLines.forEach((d, i) => { d.description = textDescs[i]; });
    }
  }

  const n = descLines.length;

  let hsnList = collectBlock(lines, /^HSN\/SAC$|^HSN$/i, n);
  let qtyList = collectBlock(lines, /^QTY\.?$/i, n);
  let rateList = collectBlock(lines, /^RATE$/i, n);
  let amountList = collectBlock(lines, /^AMOUNT$/i, n);

  // ── Row-by-row detection ─────────────────────────────────────────────────
  // When the OCR reads each table cell on its own line in row order
  // (S.No → Desc → HSN → QTY → Rate → Amount → S.No → …), the collectBlock
  // for AMOUNT returns S.No integers like "1", "2" as its first values instead
  // of monetary amounts.  Delegate to parseRowBlocks in that case.
  if (amountList.length > 0 && /^\d{1,3}$/.test(amountList[0])) {
    return parseRowBlocks(lines);
  }

  // ── Positional fallback for combined-header format ────────────────────────
  // When the OCR emits all column names on one header line
  // (e.g. "S.NO. ITEMS HSN QTY. RATE AMOUNT"), there are no standalone
  // "RATE" / "AMOUNT" anchor lines for collectBlock to find.  In that case
  // all four lists are empty and we assign value blocks positionally — in the
  // same left-to-right column order stated in the header.
  if (
    hsnList.length === 0 &&
    qtyList.length === 0 &&
    rateList.length === 0 &&
    amountList.length === 0 &&
    headerLine &&
    lastDescLineIdx >= 0
  ) {
    const needHSN = /\bHSN\b/i.test(headerLine);
    const needQTY = /\bQTY\b|\bQUANTITY\b/i.test(headerLine);
    const needRATE = /\bRATE\b|\bPRICE\b/i.test(headerLine);
    const needAMT = /\bAMOUNT\b|\bVALUE\b/i.test(headerLine);

    // Collect lines that come after the last description line, stopping at
    // tax/total markers.  Skip any stray column-header labels.
    const valueLines: string[] = [];
    for (let i = lastDescLineIdx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (
        /^CGST|^SGST|^IGST|^TOTAL|^Amount\s+Chargeable|^Sub\s*[-\s]?Total/i.test(
          l,
        )
      )
        break;
      if (/^HSN\/SAC$|^HSN$|^QTY\.?$|^RATE$|^AMOUNT$/i.test(l)) continue;
      valueLines.push(l);
    }

    let offset = 0;
    if (needHSN) { hsnList = valueLines.slice(offset, offset + n); offset += n; }
    if (needQTY) { qtyList = valueLines.slice(offset, offset + n); offset += n; }
    if (needRATE) { rateList = valueLines.slice(offset, offset + n); offset += n; }
    if (needAMT) { amountList = valueLines.slice(offset, offset + n); }
  }

  return descLines.map((d, i) => {
    const qtyRaw = qtyList[i] ?? '';
    const qtyM = qtyRaw.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]+)?/i);
    return {
      srNo: d.srNo,
      description: d.description,
      hsnCode: hsnList[i] ?? null,
      quantity: qtyM
        ? {
            value: parseFloat(qtyM[1].replace(/,/g, '')),
            unit: qtyM[2]?.toUpperCase() ?? null,
          }
        : null,
      rate: rateList[i] ? parseFloat(rateList[i].replace(/,/g, '')) : null,
      per: null,
      netAmount: amountList[i]
        ? parseFloat(amountList[i].replace(/,/g, ''))
        : 0,
    };
  });
}

// ── Row-block parser (cell-by-cell, row-by-row OCR layout) ──────────────────
// Some scanners emit each table cell as its own line in reading order:
//   S.NO. / ITEMS / HSN / QTY. / RATE / AMOUNT  ← standalone column headers
//   1                                             ← row 1, field 1
//   USK PM0028 19x14x17.25                        ← row 1, field 2
//   48191010                                      ← row 1, field 3
//   80 PCS                                        ← row 1, field 4
//   52                                            ← row 1, field 5
//   4,160                                         ← row 1, field 6
//   2                                             ← row 2, field 1 …
// This parser detects the AMOUNT standalone header (last col header emitted)
// and then consumes tokens in groups anchored by S.No + HSN validation.
function parseRowBlocks(lines: string[]): LineItem[] {
  // Find the standalone AMOUNT column header
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^AMOUNT$/i.test(lines[i].trim())) { startIdx = i + 1; break; }
  }
  if (startIdx === -1) return [];

  // Collect non-empty, non-total tokens after the AMOUNT header
  const tokens: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^CGST|^SGST|^IGST|^TOTAL|^Amount\s+Chargeable|^Sub\s*[-\s]?Total/i.test(t)) break;
    tokens.push(t);
  }

  const items: LineItem[] = [];
  let i = 0;

  while (i < tokens.length) {
    // Item group must start with a serial number (1–3 digits only)
    if (!/^\d{1,3}$/.test(tokens[i])) { i++; continue; }
    const srNo = parseInt(tokens[i], 10);

    const desc   = tokens[i + 1] ?? '';
    const hsnRaw = tokens[i + 2] ?? '';
    // HSN must be a 6–8 digit integer
    if (!/^\d{6,8}$/.test(hsnRaw)) { i++; continue; }

    const qtyRaw = tokens[i + 3] ?? '';
    const qtyM = qtyRaw.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]+)?/i);

    // Rate (token 4) and Amount (token 5) are optional.
    // Distinguish them from the next item's S.No by checking whether
    // token[i+4] is a small integer AND token[i+6] is a valid HSN —
    // if so, token[i+4] is the next S.No, not a rate.
    let rate: number | null = null;
    let netAmount = 0;
    let advance = 4;

    const tok4 = tokens[i + 4] ?? '';
    const tok5 = tokens[i + 5] ?? '';
    const tok6 = tokens[i + 6] ?? '';
    const tok8 = tokens[i + 8] ?? '';

    const tok4IsNextSrNo = /^\d{1,3}$/.test(tok4) && /^\d{6,8}$/.test(tok6);
    if (!tok4IsNextSrNo && /^[\d,]+(?:\.\d+)?$/.test(tok4)) {
      rate = parseFloat(tok4.replace(/,/g, ''));
      advance++;

      const tok5IsNextSrNo = /^\d{1,3}$/.test(tok5) && /^\d{6,8}$/.test(tok8);
      if (!tok5IsNextSrNo && /^[\d,]+(?:\.\d+)?$/.test(tok5)) {
        netAmount = parseFloat(tok5.replace(/,/g, ''));
        advance++;
      }
    }

    items.push({
      srNo,
      description: desc,
      hsnCode: hsnRaw,
      quantity: qtyM
        ? { value: parseFloat(qtyM[1].replace(/,/g, '')), unit: qtyM[2]?.toUpperCase() ?? null }
        : null,
      rate,
      per: null,
      netAmount,
    });

    i += advance;
  }

  return items;
}

// ── FIX 6: Tax extraction — handle "@" prefix and take last number on line ─────
// "Output CGST @9%  9 %  7,704.40"
//   old regex expected CGST immediately followed by digits — "@" broke it.
// New approach: skip non-digit chars after CGST/SGST/IGST, grab the rate,
// then take the LAST number on the line as the amount.
function extractTaxes(lines: string[]) {
  const t: {
    cgst: TaxEntry | null;
    sgst: TaxEntry | null;
    igst: TaxEntry | null;
  } = { cgst: null, sgst: null, igst: null };

  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    // Only treat this as a labeled tax line if the line itself contains a "%".
    // Lines with CGST/SGST but no "%" are column headers in an HSN table —
    // the HSN fallback below handles those correctly.
    if (!/%/.test(l)) continue;

    // Combine current line with the next when the amount may be split off
    // e.g. "SGST/UTGST @9%  :" on one line and "INR 283.50" on the next.
    const combined = l + ' ' + (lines[li + 1] ?? '');

    if (!t.cgst && /CGST/i.test(l)) {
      const entry = parseTaxLine(l) ?? parseTaxLine(combined);
      if (entry) t.cgst = entry;
    }
    if (!t.sgst && /SGST/i.test(l)) {
      const entry = parseTaxLine(l) ?? parseTaxLine(combined);
      if (entry) t.sgst = entry;
    }
    if (!t.igst && /IGST/i.test(l)) {
      const entry = parseTaxLine(l) ?? parseTaxLine(combined);
      if (entry) t.igst = entry;
    }
  }

  // HSN/SAC tax summary table fallback.
  // Handles two formats Vision OCR commonly produces:
  //   With %:    "40191910  1,12,639.30  9%  10,137.54  9%  10,137.54  20,275.08"
  //   Without %: "40191910  1,12,639.30  9  10,137.54  9  10,137.54  20,275.08"
  // GST rates in India are 0, 0.1, 1, 2, 5, 12, 18, 28 — always ≤ 28.
  if (!t.cgst || !t.sgst) {
    for (const l of lines) {
      const m = l.match(
        /([\d,]+(?:\.\d+)?)\s+(\d{1,2}(?:\.\d+)?)\s*%?\s+([\d,]+(?:\.\d+)?)\s+(\d{1,2}(?:\.\d+)?)\s*%?\s+([\d,]+(?:\.\d+)?)/,
      );
      if (m) {
        const rate1 = parseFloat(m[2]);
        const amt1  = parseFloat(m[3].replace(/,/g, ''));
        const rate2 = parseFloat(m[4]);
        const amt2  = parseFloat(m[5].replace(/,/g, ''));
        // Sanity: rates must be valid GST slabs, amounts must be positive
        if (rate1 <= 28 && rate2 <= 28 && amt1 > 0 && amt2 > 0) {
          if (!t.cgst) t.cgst = { rate: rate1, amount: amt1 };
          if (!t.sgst) t.sgst = { rate: rate2, amount: amt2 };
          break;
        }
      }
    }
  }

  // Cell-by-cell OCR fallback: Vision sometimes puts "2.5%" on one line and
  // "5,068.54" on the very next line.  Collect consecutive rate%/amount pairs.
  if (!t.cgst || !t.sgst) {
    const pairs: Array<{ rate: number; amount: number }> = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const rateM = lines[i].trim().match(/^(\d{1,2}(?:\.\d+)?)\s*%$/);
      if (rateM) {
        const rate = parseFloat(rateM[1]);
        const nextRaw = (lines[i + 1] ?? '').trim().replace(/,/g, '');
        const nextVal = parseFloat(nextRaw);
        if (!isNaN(nextVal) && nextVal > 100 && nextVal !== rate) {
          pairs.push({ rate, amount: nextVal });
        }
      }
    }
    if (!t.cgst && pairs[0]) t.cgst = pairs[0];
    if (!t.sgst && pairs[1]) t.sgst = pairs[1];
  }

  return t;
}

/** Extract (rate, amount) from a single tax line.
 *  Handles formats:
 *   "Output CGST @9%  9 %  7,704.40"
 *   "CGST 9% : 7,704.40"
 *   "CGST @ 9 %  7,704.40"
 */
function parseTaxLine(line: string): TaxEntry | null {
  // Rate: first number followed by %
  const rateM = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!rateM) return null;
  const rate = parseFloat(rateM[1]);

  // Amount: last standalone number on the line (ignore the rate repetition)
  const allNums = [...line.matchAll(/([\d,]+(?:\.\d+)?)/g)];
  if (allNums.length < 2) return null;
  // Take the last number that is NOT the rate (amounts are usually > 100)
  for (let i = allNums.length - 1; i >= 0; i--) {
    const val = parseFloat(allNums[i][1].replace(/,/g, ''));
    if (val !== rate && val > 0) return { rate, amount: val };
  }
  return null;
}

// ── FIX 7 (revised): Totals ────────────────────────────────────────────────────
// Problem A: Google Vision may output ₹ as "Rs.", "Rs", or ₨ — broaden detection.
// Problem B: The "Ultimate fallback" was matching IFSC "TMBL000**0256**" → parseFloat = 256.
// Fix: (1) normalise currency markers before matching, (2) replace the unsafe
//      last-15-lines fallback with a full-document scan that skips known non-amount fields.
function extractTotals(lines: string[]) {
  const t: {
    subtotal: number | null;
    taxAmount: number | null;
    packagingForwarding: number | null;
    grandTotal: number | null;
  } = { subtotal: null, taxAmount: null, packagingForwarding: null, grandTotal: null };

  // Normalise currency markers so all downstream patterns only check [₹]
  const normalize = (s: string) =>
    s.replace(/Rs\.?\s*|₨\s*/gi, '₹').replace(/INR\s*/gi, '₹');

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const l = normalize(raw);

    // Explicit "Grand Total" / "G. Total"
    if (/G\.?\s*TOTAL|GRAND\s*TOTAL/i.test(l)) {
      const m = l.match(/[₹]?\s*([\d,]+\.?\d*)\s*$/);
      if (m) {
        t.grandTotal = parseIndianNumber(m[1]);
      } else {
        // Cell-by-cell OCR: label on this line, value on the next
        const next = normalize(lines[li + 1] ?? '');
        const mn = next.match(/^[₹]?\s*([\d,]+\.?\d*)\s*$/);
        if (mn) t.grandTotal = parseIndianNumber(mn[1]);
      }
      continue;
    }

    // "Total" line — skip tax-amount totals, handle "TOTAL QTY X  TOTAL ₹ Y" format
    if (/^TOTAL\b/i.test(l)) {
      if (/IN\s*WORDS/i.test(l)) continue;
      // "Total Tax Amount" — treat as taxAmount label, not grandTotal
      if (/TAX\s*AMOUNT/i.test(l) && !t.taxAmount) {
        const m = l.match(/[₹]?\s*([\d,]+\.?\d*)\s*$/);
        if (m) {
          const val = parseIndianNumber(m[1]);
          if (val > 0) t.taxAmount = val;
        } else {
          const next = normalize(lines[li + 1] ?? '');
          const mn = next.match(/^[₹]?\s*([\d,]+\.?\d*)\s*$/);
          if (mn) { const val = parseIndianNumber(mn[1]); if (val > 0) t.taxAmount = val; }
        }
        continue;
      }
      if (/TAX\s*AMOUNT/i.test(l)) continue;
      const hasRupee = /[₹]/.test(l);
      const m = l.match(/[₹]?\s*([\d,]+\.?\d*)\s*$/);
      if (m) {
        const val = parseIndianNumber(m[1]);
        if (hasRupee) {
          if (!t.grandTotal || val > t.grandTotal) t.grandTotal = val;
        } else {
          t.subtotal = val;
        }
      } else {
        // Cell-by-cell OCR: scan ahead up to 6 lines for the amount,
        // skipping CGST/SGST/tax-rate lines.
        for (let ahead = 1; ahead <= 6; ahead++) {
          const nxt = normalize(lines[li + ahead] ?? '');
          if (!nxt) continue;
          // Stop if we hit another label line
          if (/^(?:CGST|SGST|IGST|ADD|ROUND|AMOUNT|TOTAL|SUB)/i.test(nxt)) continue;
          const mn = nxt.match(/^[₹]?\s*([\d,]+(?:\.\d+)?)\s*$/);
          if (mn) {
            const val = parseIndianNumber(mn[1]);
            // Grand total must be larger than any individual line item (~5000+)
            if (val > 5000 && (!t.grandTotal || val > t.grandTotal)) {
              t.grandTotal = val;
            }
            break;
          }
        }
      }
      continue;
    }

    // "Tax Amount" / "Total Tax Amount" — explicit tax total line in summary sections
    if (/^(?:TOTAL\s+)?TAX\s+AMOUNT\b/i.test(l) && !t.taxAmount) {
      const m = l.match(/[₹]?\s*([\d,]+\.?\d*)\s*$/);
      if (m) {
        const val = parseIndianNumber(m[1]);
        if (val > 0) t.taxAmount = val;
      } else {
        const next = normalize(lines[li + 1] ?? '');
        const mn = next.match(/^[₹]?\s*([\d,]+\.?\d*)\s*$/);
        if (mn) {
          const val = parseIndianNumber(mn[1]);
          if (val > 0) t.taxAmount = val;
        }
      }
    }

    if (/PACKAGING|FORWARDING/i.test(l)) {
      const m = l.match(/[₹]?\s*([\d,]+\.?\d*)\s*$/);
      if (m) {
        const val = parseIndianNumber(m[1]);
        if (val > 0) t.packagingForwarding = val;
      }
    }
  }

  // Fallback 1: scan whole doc for first ₹ amount > 1000
  // (handles "₹ 1,01,013.00" on a standalone line after the Total row)
  if (!t.grandTotal) {
    for (const raw of [...lines].reverse()) {
      const l = normalize(raw);
      // Skip lines that are clearly non-invoice-amount (bank/IFSC/date fields)
      if (
        /IFSC|IFS\s*CODE|A\/C\s*NO|ACCOUNT|UDYAM|ACK\s*NO|MOTOR\s*VEHICLE|E-WAY/i.test(
          raw,
        )
      )
        continue;
      const m = l.match(/[₹]\s*([\d,]+\.?\d*)/);
      if (m) {
        const val = parseIndianNumber(m[1]);
        if (val > 1000) {
          t.grandTotal = val;
          break;
        }
      }
    }
  }

  // Fallback 2: scan full doc for largest Indian-format number (only when grandTotal still missing).
  if (!t.grandTotal) {
    const SKIP_LINE =
      /IFSC|IFS\s*CODE|A\/C\s*NO|ACCOUNT|IRN\b|UDYAM|ACK\s*NO|MOTOR\s*VEHICLE|E-WAY|PHONE|MOB|HSN|QTY|RATE|CGST|SGST|IGST/i;
    let best = 0;
    for (const l of lines) {
      if (SKIP_LINE.test(l)) continue;
      for (const m of l.matchAll(/([\d,]+(?:\.\d+)?)/g)) {
        // Skip 6+ digit integers without commas — these are HSN/SAC codes or reference numbers,
        // not monetary amounts (Indian amounts use comma-grouping or have decimal fractions)
        if (m[1].length >= 6 && !m[1].includes(',') && !m[1].includes('.')) continue;
        const val = parseIndianNumber(m[1]);
        if (val > 1000 && val < 1e9 && val > best) best = val;
      }
    }
    if (best > 0) t.grandTotal = best;
  }

  // Fallback 3: if grandTotal looks like a pre-tax subtotal (because TOTAL scan-ahead
  // grabbed the taxable value row), find the real net total = grandTotal + taxAmount.
  // Cell-by-cell OCR puts the true payable amount after the tax rows.
  if (t.grandTotal != null && t.taxAmount != null && t.taxAmount > 0) {
    const expected = t.grandTotal + t.taxAmount;
    const SKIP_LINE =
      /IFSC|IFS\s*CODE|A\/C\s*NO|ACCOUNT|IRN\b|UDYAM|ACK\s*NO|MOTOR\s*VEHICLE|E-WAY|PHONE|MOB|HSN|QTY|RATE|CGST|SGST|IGST/i;
    for (const l of lines) {
      if (SKIP_LINE.test(l)) continue;
      for (const m of l.matchAll(/([\d,]+(?:\.\d+)?)/g)) {
        const val = parseIndianNumber(m[1]);
        // Allow ±2 tolerance for round-off
        if (Math.abs(val - expected) <= 2 && val > (t.grandTotal ?? 0)) {
          t.grandTotal = val;
          break;
        }
      }
    }
  }

  return t;
}

// ── Amount in words — per-line check for ONLY keyword ─────────────────────────
function extractAmountInWords(lines: string[]) {
  for (const l of lines) {
    if (/\b(?:LAKH|THOUSAND|HUNDRED|CRORE)\b/i.test(l) && /ONLY\s*$/i.test(l)) {
      // Strip leading "INR" / "Rs." prefix for cleaner display
      return l.replace(/^(?:INR|RS\.?|RUPEES)\s*/i, '').trim();
    }
  }
  // Fallback: scan joined text
  const combined = lines.join(' ');
  const m = combined.match(
    /(?:INR|RS\.?\s*)?\s*([A-Z\s]+(?:THOUSAND|LAKH|HUNDRED|CRORE)[A-Z\s]+ONLY)/i,
  );
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function extractContactDetails(rawText: string) {
  const phones = [
    ...new Set(
      [
        ...rawText.matchAll(
          /(?:\+91[\s-]?)?(?:\(0\d{2,3}\)[\s-]?)?\d{10}|\b0\d{2,3}[\s-]\d{7,8}\b/g,
        ),
      ].map((m) => m[0].replace(/\s/g, '')),
    ),
  ];
  const emails = [
    ...new Set(
      [
        ...rawText.matchAll(
          /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
        ),
      ].map((m) => m[0].toLowerCase()),
    ),
  ];
  return { phones, emails };
}

function detectInvoiceType(fullText: string) {
  if (/TAX\s+INVOICE/i.test(fullText)) return 'TAX_INVOICE';
  if (/PROFORMA/i.test(fullText)) return 'PROFORMA';
  if (/CREDIT\s+NOTE/i.test(fullText)) return 'CREDIT_NOTE';
  if (/DEBIT\s+NOTE/i.test(fullText)) return 'DEBIT_NOTE';
  if (/PURCHASE\s+ORDER|P\.O\./i.test(fullText)) return 'PURCHASE_ORDER';
  if (/RECEIPT/i.test(fullText)) return 'RECEIPT';
  return 'INVOICE';
}

// ── New helpers for target schema ────────────────────────────────────────────

/** Extract vendor address lines (block below vendor name, before GSTIN/Mobile). */
function extractVendorAddress(lines: string[]): string[] {
  let nameIdx = -1;
  const SKIP =
    /^\(|^e-?Invoice|^IRN|^Ack\s|^Tax\s+Invoice|ORIGINAL\s+FOR|RECIPIENT/i;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const t = lines[i].trim();
    if (SKIP.test(t) || t.length < 6) continue;
    if (
      /PRIVATE|LIMITED|PVT|LTD|TRADE|ENTERPRISES|CORP|INDUSTRIES|SERVICES|SOLUTIONS/i.test(
        t,
      )
    ) {
      nameIdx = i;
      break;
    }
  }
  if (nameIdx === -1) return [];
  const addr: string[] = [];
  for (let i = nameIdx + 1; i < Math.min(nameIdx + 8, lines.length); i++) {
    const l = lines[i].trim();
    if (/^GSTIN|^Mobile|^E-?Mail|^Bill\s+To|^Ship\s+To|^Invoice\s+No/i.test(l))
      break;
    if (l.length > 2) addr.push(l);
  }
  return addr;
}

/** Extract PO number e.g. "P.O. No. USK/25-26/1516" */
function extractPONumber(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(
      /P\.?O\.?\s*(?:No\.?|Number)?\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
    );
    if (m && /\d/.test(m[1])) return m[1].trim();
  }
  return null;
}

/** Extract PO date e.g. "PO Date 26-02-2026" */
function extractPODate(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(
      /PO\s+Date\s*[:\-]?\s*(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4})/i,
    );
    if (m) return m[1].trim();
  }
  return null;
}

/** Extract place of supply e.g. "Place of Supply: Maharashtra" */
function extractPlaceOfSupply(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(/Place\s+of\s+Supply\s*[:\-]?\s*(.+)/i);
    if (m) return m[1].trim();
  }
  return null;
}

/** Extract payment terms e.g. "Payment Terms: 30 days" or "Due in 45 days" */
function extractPaymentTerms(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(
      /(?:Payment\s+Terms?|Mode.*Payment|Due\s+in)\s*[:\-]?\s*(.+)/i,
    );
    if (m && m[1].trim().length > 1) return m[1].trim();
  }
  return null;
}

// ── New field extractors ──────────────────────────────────────────────────────

function extractEWayBillNo(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(/e-?Way\s*Bill\s*(?:No\.?)?\s*[:\-]?\s*([0-9]{10,})/i);
    if (m) return m[1].trim();
  }
  return null;
}

function extractMotorVehicleNo(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(
      /Motor\s*Vehicle\s*(?:No\.?)?\s*[:\-]?\s*([A-Z]{2}\d{2}[A-Z0-9]{1,2}\d{4})/i,
    );
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractUdyamNo(rawText: string): string | null {
  const m = rawText.match(
    /UDYAM[\s\-](?:REG\.?\s*NO\.?\s*[:\-]?\s*)?([A-Z0-9\-]+)/i,
  );
  return m ? m[1].trim() : null;
}

function extractShipTo(
  lines: string[],
): { name: string | null; address: string | null } | null {
  const idx = lines.findIndex((l) => /^SHIP\s+TO/i.test(l));
  if (idx === -1) return null;
  const chunk: string[] = [];
  for (let i = idx + 1; i < Math.min(idx + 8, lines.length); i++) {
    const l = lines[i];
    if (/^BILL\s+TO|^BUYER|GSTIN|^S\.?NO|DESCRIPTION|HSN/i.test(l)) break;
    if (l.trim().length > 2) chunk.push(l.trim());
  }
  if (chunk.length === 0) return null;
  return {
    name: chunk[0].replace(/^Address\s*:\s*/i, '').trim() || null,
    address: chunk.slice(1).join(', ') || null,
  };
}

function extractTDS(lines: string[]): number | null {
  for (const l of lines) {
    if (/TDS\b|TAX\s+DEDUCT/i.test(l)) {
      const m = l.match(/([\d,]+\.?\d*)\s*$/);
      if (m) return parseIndianNumber(m[1]);
    }
  }
  return null;
}

function extractRoundOff(lines: string[]): number | null {
  for (const l of lines) {
    if (/ROUND\s*OFF/i.test(l)) {
      const m = l.match(/\(?(-?[\d.]+)\)?\s*$/);
      if (m) {
        const isNeg = /\(-\)/.test(l) || m[1].startsWith('-');
        return isNeg ? -Math.abs(parseFloat(m[1])) : parseFloat(m[1]);
      }
    }
  }
  return null;
}

export function validateInvoice(parsed: ParsedInvoice) {
  const issues: string[] = [];
  let score = 100;

  if (!parsed.vendor?.name) {
    issues.push('Vendor name missing');
    score -= 15;
  }
  if (!parsed.invoiceNo) {
    issues.push('Invoice number missing');
    score -= 10;
  }
  if (!parsed.date) {
    issues.push('Invoice date missing');
    score -= 10;
  }
  if (!parsed.totals?.grandTotal) {
    issues.push('Grand total missing');
    score -= 20;
  }
  if (parsed.items.length === 0) {
    issues.push('No line items detected');
    score -= 20;
  }
  if (parsed.gstNumbers.length === 0) {
    issues.push('No GST number found');
    score -= 10;
  }

  if (parsed.totals.subtotal && parsed.totals.grandTotal) {
    const taxTotal = parsed.totals.taxAmount ?? 0;
    const roundOff = parsed.totals.roundOff ?? 0;
    const diff = Math.abs(
      parsed.totals.subtotal + taxTotal + roundOff - parsed.totals.grandTotal,
    );
    if (diff > 10) {
      issues.push(`Total mismatch: ₹${diff.toFixed(0)} difference`);
      score -= 15;
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
    confidence: { score: Math.max(0, score) },
  };
}

export function formatINR(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(amount);
}

// ── Export helper — returns only the clean JSON fields (no app internals) ─────
export function toExportJSON(invoice: ParsedInvoice): object {
  const {
    invoiceNo,
    date,
    eWayBillNo,
    vendor,
    customer,
    shipTo,
    items,
    totals,
    bankDetails,
    dispatch,
    paymentTerms,
    notes,
    rawText,
  } = invoice;
  return {
    invoiceNo,
    date,
    eWayBillNo,
    vendor,
    customer,
    shipTo,
    items,
    totals,
    bankDetails,
    dispatch,
    paymentTerms,
    notes,
    rawText,
  };
}
