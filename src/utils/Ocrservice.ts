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
    PONo: { type: 'STRING', nullable: true },
    ItemNo: { type: 'STRING', nullable: true },
    ItemDesc: { type: 'STRING' },
    Rate: { type: 'NUMBER', nullable: true },
    Qty: { type: 'NUMBER', nullable: true },
    BatchNo: { type: 'STRING', nullable: true },
  },
  required: ['ItemDesc'],
} as const;

const GOODS_SCHEMA = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    Supplier: { type: 'STRING', nullable: true },
    SupplierGSTNo: { type: 'STRING', nullable: true },
    ChallanNo: { type: 'STRING', nullable: true },
    ChallanDate: { type: 'STRING', nullable: true },
    InvoiceNo: { type: 'STRING', nullable: true },
    InvoiceDate: { type: 'STRING', nullable: true },
    VehicleNo: { type: 'STRING', nullable: true },
    LRNo: { type: 'STRING', nullable: true },
    Transporter: { type: 'STRING', nullable: true },
    Items: { type: 'ARRAY', items: GOODS_ITEM_SCHEMA },
  },
} as const;

const PAYMENT_ADVICE_SCHEMA = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    Payer: { type: 'STRING', nullable: true },
    PaymentRef: { type: 'STRING', nullable: true },
    PaymentDate: { type: 'STRING', nullable: true },
    GrandTotal: { type: 'NUMBER', nullable: true },
    References: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          PONo: { type: 'STRING', nullable: true },
          DocNo: { type: 'STRING', nullable: true },
          DocDate: { type: 'STRING', nullable: true },
          GRNNo: { type: 'STRING', nullable: true },
          InvoiceAmount: { type: 'NUMBER', nullable: true },
          Deduction: { type: 'NUMBER', nullable: true },
          Amount: { type: 'NUMBER', nullable: true },
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

STEP 3 — EXTRACT into the schema (field names are case-sensitive — use them EXACTLY as written):
For goods documents (TAX_INVOICE / DELIVERY_CHALLAN / EWAY_BILL) fill "goods" and set "paymentAdvice" to null:
- Supplier / SupplierGSTNo: the issuing seller and its GSTIN.
- InvoiceNo + InvoiceDate, and ChallanNo + ChallanDate if a separate challan number/date is printed (else null).
- VehicleNo, LRNo (L.R. No.), Transporter (transporter name) — often on the e-Way Bill / dispatch section of a merged document.
- Items[]: EVERY line, with these per-item fields:
  - PONo: the purchase / order number for that line (labels: "PO No", "Order No", "Order No1"). If a single PO covers the whole document, repeat it on every item.
  - ItemNo: item / part code (as string).
  - ItemDesc: the goods description.
  - Rate: per-unit price (numeric).
  - Qty: quantity (numeric).
  - BatchNo: lot / batch number if present, else null.

For PAYMENT_ADVICE fill "paymentAdvice" and set "goods" to null:
- Payer (who is paying / on whose behalf), PaymentRef (UTR / instrument no), PaymentDate, GrandTotal.
- References[]: each settled invoice row — PONo, DocNo, DocDate, GRNNo, InvoiceAmount, Deduction (TDS/deduction), Amount (net paid).

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
    ? { ...raw.goods, Items: raw.goods.Items ?? [] }
    : null;
  const paymentAdvice = raw.paymentAdvice
    ? { ...raw.paymentAdvice, References: raw.paymentAdvice.References ?? [] }
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
    Supplier: p.vendor?.name ?? null,
    SupplierGSTNo: p.vendor?.taxId ?? p.gstNumbers?.[0] ?? null,
    ChallanNo: null,
    ChallanDate: null,
    InvoiceNo: p.invoiceNo ?? null,
    InvoiceDate: p.date ?? null,
    VehicleNo: p.dispatch?.motorVehicleNo ?? null,
    LRNo: p.dispatch?.lrNumber ?? p.lrNumber ?? null,
    Transporter: p.dispatch?.transport ?? p.transport ?? null,
    Items: (p.items ?? []).map((i) => ({
      PONo: null,
      ItemNo: i.itemNo != null ? String(i.itemNo) : null,
      ItemDesc: i.description,
      Rate: i.unitPrice ?? null,
      Qty: i.quantity ?? null,
      BatchNo: null,
    })),
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
