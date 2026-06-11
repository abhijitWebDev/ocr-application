// utils/Ocrservice.ts
import * as FileSystem from 'expo-file-system/legacy';

import { parseInvoice, type ParsedInvoice } from './Invoiceparser';
import {
  type DocType,
  type ExtractedDocument,
  type ExtractionResult,
  type GoodsDoc,
} from './Schema';

const VISION_API_KEY = process.env.EXPO_PUBLIC_VISION_KEY || '';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_KEY || VISION_API_KEY;

// ── Google Vision endpoints (fallback) ───────────────────────────────────────
const IMAGE_ANNOTATE_URL = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`;
const FILE_ANNOTATE_URL = `https://vision.googleapis.com/v1/files:annotate?key=${VISION_API_KEY}`;

// ── Gemini endpoint ───────────────────────────────────────────────────────────
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ── Input type ─────────────────────────────────────────────────────────────────
export interface ScanInput {
  uri: string;
  mime: string; // image/jpeg | image/png | image/webp | application/pdf
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function uriToBase64(uri: string): Promise<string> {
  return await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

function isPDF(input: ScanInput): boolean {
  return (
    input.mime === 'application/pdf' ||
    /\.pdf($|\?)/i.test(input.uri) ||
    input.uri.includes('application%2Fpdf')
  );
}

function generateId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// ── Gemini structured-output schema (OpenAPI subset) ──────────────────────────
// Both `goods` and `paymentAdvice` are nullable; the model fills only the one
// matching `docType`. This avoids relying on Gemini union (anyOf) support.

const GOODS_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    itemNo: { type: 'STRING', nullable: true },
    itemDesc: { type: 'STRING' },
    hsnCode: { type: 'STRING', nullable: true },
    qty: { type: 'NUMBER', nullable: true },
    unit: { type: 'STRING', nullable: true },
    rate: { type: 'NUMBER', nullable: true },
    amount: { type: 'NUMBER', nullable: true },
    batchNo: { type: 'STRING', nullable: true },
  },
  required: ['itemDesc'],
} as const;

const GOODS_SCHEMA = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    supplier: { type: 'STRING', nullable: true },
    supplierGSTNo: { type: 'STRING', nullable: true },
    invoiceNo: { type: 'STRING', nullable: true },
    invoiceDate: { type: 'STRING', nullable: true },
    challanNo: { type: 'STRING', nullable: true },
    challanDate: { type: 'STRING', nullable: true },
    poNo: { type: 'STRING', nullable: true },
    eWayBillNo: { type: 'STRING', nullable: true },
    vehicleNo: { type: 'STRING', nullable: true },
    lrNo: { type: 'STRING', nullable: true },
    transporter: { type: 'STRING', nullable: true },
    items: { type: 'ARRAY', items: GOODS_ITEM_SCHEMA },
    taxableValue: { type: 'NUMBER', nullable: true },
    taxAmount: { type: 'NUMBER', nullable: true },
    invoiceTotal: { type: 'NUMBER', nullable: true },
  },
} as const;

const PAYMENT_ADVICE_SCHEMA = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    payer: { type: 'STRING', nullable: true },
    paymentRef: { type: 'STRING', nullable: true },
    paymentDate: { type: 'STRING', nullable: true },
    grandTotal: { type: 'NUMBER', nullable: true },
    references: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          poNo: { type: 'STRING', nullable: true },
          docNo: { type: 'STRING', nullable: true },
          docDate: { type: 'STRING', nullable: true },
          grnNo: { type: 'STRING', nullable: true },
          invoiceAmount: { type: 'NUMBER', nullable: true },
          deduction: { type: 'NUMBER', nullable: true },
          amount: { type: 'NUMBER', nullable: true },
        },
      },
    },
  },
} as const;

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    documents: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          docType: {
            type: 'STRING',
            enum: [
              'TAX_INVOICE',
              'DELIVERY_CHALLAN',
              'EWAY_BILL',
              'PAYMENT_ADVICE',
              'OTHER',
            ],
          },
          goods: GOODS_SCHEMA,
          paymentAdvice: PAYMENT_ADVICE_SCHEMA,
          rawText: { type: 'STRING' },
        },
        required: ['docType'],
      },
    },
  },
  required: ['documents'],
} as const;

// ── Gemini prompt ─────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a precise document data-extraction specialist for Indian commercial documents — tax invoices, delivery challans, e-way bills, and bank/vendor payment advices — printed or handwritten, from any region.

You are given ONE OR MORE pages (images and/or PDF pages). They may belong to a single document, several pages of one document, or multiple distinct documents bundled together.

STEP 1 — SEGMENT the pages into logical documents:
- A table that continues across pages (e.g. a payment advice whose line table spills onto the next page, with totals only on the last page) is ONE document — combine all its pages.
- A tax invoice followed by its e-Way Bill / delivery challan for the SAME transaction is ONE document — MERGE them: take line items and amounts from the invoice, and fill vehicleNo / lrNo / transporter / eWayBillNo from the e-Way Bill or challan page.
- Unrelated documents (different suppliers, different transactions) are SEPARATE documents.

STEP 2 — CLASSIFY each document's docType: TAX_INVOICE, DELIVERY_CHALLAN, EWAY_BILL, PAYMENT_ADVICE, or OTHER.

STEP 3 — EXTRACT into the schema:
For goods documents (TAX_INVOICE / DELIVERY_CHALLAN / EWAY_BILL) fill "goods" and set "paymentAdvice" to null:
- supplier / supplierGSTNo: the issuing seller and its GSTIN.
- invoiceNo + invoiceDate, and challanNo + challanDate if a separate challan number/date is printed (else null).
- poNo: the buyer's purchase / order number — HEADER level, one per document (labels: "PO No", "Order No", "Order No1"). Do NOT repeat it per item.
- eWayBillNo, vehicleNo, lrNo (L.R. No.), transporter (transporter name) — often on the e-Way Bill / dispatch section.
- items[]: EVERY line. itemNo (item/code, as string), itemDesc, hsnCode, qty (numeric), unit (UOM such as KG, Rolls, Sheets, Pcs — required when shown; the same line may show both a piece count and a weight, prefer the billed quantity and put its unit), rate (per-unit price), amount (line value), batchNo (lot/batch if present, else null).
- taxableValue, taxAmount (total GST: CGST+SGST+IGST), invoiceTotal (final payable).

For PAYMENT_ADVICE fill "paymentAdvice" and set "goods" to null:
- payer (who is paying / on whose behalf), paymentRef (UTR / instrument no), paymentDate, grandTotal.
- references[]: each settled invoice row — poNo, docNo, docDate, grnNo, invoiceAmount, deduction (TDS/deduction), amount (net paid).

Rules:
- Use null for any field genuinely absent or illegible. Do not invent values.
- Numbers must be plain numerics (strip ₹, Rs., commas).
- rawText: full verbatim transcription of that document's text, page by page (used for verification).
- Return ALL documents you find in the "documents" array.`;

// ── Gemini extraction (multi-page / multi-document, structured) ───────────────

async function callGeminiExtraction(
  inputs: ScanInput[],
): Promise<Partial<ExtractedDocument>[]> {
  const parts: any[] = [];
  for (const input of inputs) {
    const data = await uriToBase64(input.uri);
    parts.push({ inlineData: { mimeType: input.mime, data } });
  }
  parts.push({ text: EXTRACTION_PROMPT });

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      `Gemini API error: ${err.error?.message || response.status}`,
    );
  }

  const data = await response.json();
  // Gemini 2.5+ may return thinking parts (thought: true) — pick the JSON one.
  const respParts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  const textPart = respParts.find((p) => p.text && !p.thought) ?? respParts[0];
  const raw: string = textPart?.text?.trim() ?? '';

  let parsed: { documents?: any[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Gemini returned unparseable JSON');
  }

  const docs = parsed.documents ?? [];
  if (docs.length === 0) throw new Error('No documents detected');
  return docs;
}

/** Normalise a raw Gemini document object into a complete ExtractedDocument. */
function normaliseDocument(
  raw: Partial<ExtractedDocument>,
  imageUris: string[],
): ExtractedDocument {
  const docType = (raw.docType ?? 'OTHER') as DocType;
  const goods = raw.goods
    ? { ...raw.goods, items: raw.goods.items ?? [] }
    : null;
  const paymentAdvice = raw.paymentAdvice
    ? { ...raw.paymentAdvice, references: raw.paymentAdvice.references ?? [] }
    : null;

  return {
    id: generateId(),
    scannedAt: new Date().toISOString(),
    docType,
    imageUris,
    goods,
    paymentAdvice,
    rawText: raw.rawText ?? '',
  };
}

// ── Legacy fallback (Google Vision raw text → regex parser) ───────────────────

function parsedInvoiceToGoodsDoc(p: ParsedInvoice): GoodsDoc {
  return {
    supplier: p.vendor?.name ?? null,
    supplierGSTNo: p.vendor?.taxId ?? p.gstNumbers?.[0] ?? null,
    invoiceNo: p.invoiceNo ?? null,
    invoiceDate: p.date ?? null,
    challanNo: null,
    challanDate: null,
    poNo: null,
    eWayBillNo: p.eWayBillNo ?? null,
    vehicleNo: p.dispatch?.motorVehicleNo ?? null,
    lrNo: p.dispatch?.lrNumber ?? p.lrNumber ?? null,
    transporter: p.dispatch?.transport ?? p.transport ?? null,
    items: (p.items ?? []).map((i) => ({
      itemNo: i.itemNo != null ? String(i.itemNo) : null,
      itemDesc: i.description,
      hsnCode: i.hsnCode ?? null,
      qty: i.quantity ?? null,
      unit: i.unit ?? null,
      rate: i.unitPrice ?? null,
      amount: i.totalAmount ?? null,
      batchNo: null,
    })),
    taxableValue: p.totals?.subtotal ?? null,
    taxAmount: p.totals?.taxAmount ?? null,
    invoiceTotal: p.totals?.grandTotal ?? null,
  };
}

async function fallbackExtractOne(input: ScanInput): Promise<ExtractedDocument> {
  const rawText = isPDF(input)
    ? await performOCRFromPDF(input.uri)
    : await performOCR(input.uri);
  const parsed = await parseInvoice(rawText);
  return {
    id: generateId(),
    scannedAt: new Date().toISOString(),
    docType: 'TAX_INVOICE',
    imageUris: [input.uri],
    goods: parsedInvoiceToGoodsDoc(parsed),
    paymentAdvice: null,
    rawText,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Extract structured documents from one or more pages/files in a single pass.
 * Primary path: Gemini structured output (segments + classifies + merges).
 * Fallback: Google Vision raw text + regex parser, one document per input.
 */
export async function performExtraction(
  inputs: ScanInput[],
): Promise<ExtractionResult> {
  const imageUris = inputs.map((i) => i.uri);
  try {
    const rawDocs = await callGeminiExtraction(inputs);
    return { documents: rawDocs.map((d) => normaliseDocument(d, imageUris)) };
  } catch {
    // Fallback: process each input independently via Vision + regex parser.
    const documents: ExtractedDocument[] = [];
    for (const input of inputs) {
      documents.push(await fallbackExtractOne(input));
    }
    return { documents };
  }
}

// ── Google Vision raw-text helpers (used by fallback) ─────────────────────────

async function extractTextFromImage(base64Image: string): Promise<string> {
  const response = await fetch(IMAGE_ANNOTATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64Image },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Vision API error: ${err.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  const text = data.responses?.[0]?.fullTextAnnotation?.text;
  if (!text) throw new Error('No text detected in image');
  return text;
}

async function extractTextFromPDF(base64PDF: string): Promise<string> {
  const response = await fetch(FILE_ANNOTATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          inputConfig: { content: base64PDF, mimeType: 'application/pdf' },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          pages: [1, 2, 3, 4, 5],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Vision PDF error: ${err.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  const pageResponses: any[] = data.responses?.[0]?.responses ?? [];
  if (pageResponses.length === 0) throw new Error('No text detected in PDF');

  const allText = pageResponses
    .map((r: any, i: number) => {
      const pageText: string = r.fullTextAnnotation?.text ?? '';
      return pageText ? `--- Page ${i + 1} ---\n${pageText}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  if (!allText) throw new Error('No text detected in PDF');
  return allText;
}

/** Raw text extraction via Google Vision (image). */
export async function performOCR(imageUri: string): Promise<string> {
  const base64 = await uriToBase64(imageUri);
  return extractTextFromImage(base64);
}

/** Raw text extraction via Google Vision (PDF). */
export async function performOCRFromPDF(pdfUri: string): Promise<string> {
  const base64 = await uriToBase64(pdfUri);
  return extractTextFromPDF(base64);
}
