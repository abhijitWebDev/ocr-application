// utils/Ocrservice.ts
import * as FileSystem from 'expo-file-system/legacy';

import {
  type DocType,
  type ExtractedDocument,
  type ExtractionResult,
} from './Schema';

const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_KEY || '';

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

function generateId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient Gemini failures (rate-limit / overloaded / server error) that are
// worth retrying rather than surfacing to the user.
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_RETRIES = 4;

/**
 * POST to Gemini, retrying transient 429/500/503 responses (and network
 * errors) with exponential backoff + jitter. Returns the successful Response;
 * throws with the API's message once retries are exhausted.
 */
async function fetchGeminiWithRetry(body: string): Promise<Response> {
  let lastMessage = 'Gemini request failed';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 1s, 2s, 4s, 8s … capped, with a little jitter to avoid thundering herd.
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await sleep(delay + Math.random() * 300);
    }

    let response: Response;
    try {
      response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e: any) {
      // Network-level failure (no response) — retry while attempts remain.
      lastMessage = e?.message || 'Network error';
      continue;
    }

    if (response.ok) return response;

    const err = await response.json().catch(() => ({}));
    lastMessage = err.error?.message || `HTTP ${response.status}`;

    // Non-transient status (e.g. 400 bad request, 403 auth) — fail immediately.
    if (!RETRYABLE_STATUS.has(response.status)) {
      throw new Error(`Gemini API error: ${lastMessage}`);
    }
    // Transient (429/500/503) — loop and retry.
  }
  throw new Error(
    `Gemini is busy right now (it kept returning errors). Please try again in a moment. (${lastMessage})`,
  );
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
    TaxableValue: { type: 'NUMBER', nullable: true },
    CGSTRate: { type: 'NUMBER', nullable: true },
    CGSTAmount: { type: 'NUMBER', nullable: true },
    SGSTRate: { type: 'NUMBER', nullable: true },
    SGSTAmount: { type: 'NUMBER', nullable: true },
    IGSTRate: { type: 'NUMBER', nullable: true },
    IGSTAmount: { type: 'NUMBER', nullable: true },
    TotalTaxAmount: { type: 'NUMBER', nullable: true },
    RoundOff: { type: 'NUMBER', nullable: true },
    InvoiceTotal: { type: 'NUMBER', nullable: true },
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
- Document-level tax summary (from the HSN/SAC tax table or the tax rows near the total — one set per document):
  - TaxableValue: the total taxable value (taxable amount before tax).
  - CGSTRate / CGSTAmount, SGSTRate / SGSTAmount, IGSTRate / IGSTAmount: the % rate and the rupee amount for each tax head. Intra-state invoices have CGST + SGST (leave IGST null); inter-state invoices have IGST only (leave CGST/SGST null). Use null for any head not present.
  - TotalTaxAmount: total tax (CGST + SGST + IGST).
  - RoundOff: rounding adjustment near the grand total (may be negative), else null.
  - InvoiceTotal: the final grand total payable (taxable value + tax + round off).

For PAYMENT_ADVICE fill "paymentAdvice" and set "goods" to null:
- Payer (who is paying / on whose behalf), PaymentRef (UTR / instrument no), PaymentDate, GrandTotal.
- References[]: each settled invoice row — PONo, DocNo, DocDate, GRNNo, InvoiceAmount, Deduction (TDS/deduction), Amount (net paid).

Rules:
- Use null for any field genuinely absent or illegible. Do not invent values.
- Numbers must be plain numerics (strip ₹, Rs., commas).
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

  const response = await fetchGeminiWithRetry(
    JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0,
        // Structured fields only (no rawText transcription). Scale modest
        // headroom with page count; cap at the model's 65536 output limit.
        maxOutputTokens: Math.min(8192 + inputs.length * 3072, 65536),
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA,
        // gemini-2.5-flash enables "thinking" by default, which silently eats
        // into maxOutputTokens and truncates the JSON on multi-page scans.
        // Disable it — structured extraction doesn't need it.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  );

  const data = await response.json();
  const candidate = data.candidates?.[0];
  // If the model ran out of output budget the JSON is truncated → give an
  // actionable error instead of a generic parse failure.
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(
      candidate.finishReason === 'MAX_TOKENS'
        ? 'Document response was too large to process. Try scanning fewer pages at once.'
        : `Gemini stopped early (${candidate.finishReason}).`,
    );
  }
  // Gemini 2.5+ may return thinking parts (thought: true) — pick the JSON one.
  const respParts: any[] = candidate?.content?.parts ?? [];
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

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Extract structured documents from one or more pages/files in a single pass
 * via Gemini structured output (segments + classifies + merges).
 */
export async function performExtraction(
  inputs: ScanInput[],
): Promise<ExtractionResult> {
  const imageUris = inputs.map((i) => i.uri);
  const rawDocs = await callGeminiExtraction(inputs);
  return { documents: rawDocs.map((d) => normaliseDocument(d, imageUris)) };
}
