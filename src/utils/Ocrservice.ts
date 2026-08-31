// utils/Ocrservice.ts
import * as FileSystem from 'expo-file-system/legacy';

import {
  type DocType,
  type ExtractedDocument,
  type ExtractionResult,
} from './Schema';

const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_KEY || '';

// ── Gemini endpoint ───────────────────────────────────────────────────────────
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${GEMINI_API_KEY}`;

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
    ItemNo: { type: 'STRING', nullable: true },
    ItemDesc: { type: 'STRING' },
    Rate: { type: 'NUMBER', nullable: true },
    Qty: { type: 'NUMBER', nullable: true },
    Weight: { type: 'NUMBER', nullable: true },
    BatchNo: { type: 'STRING', nullable: true },
    // Reconciliation aids — pure transcription, stripped before export. They
    // let `reconcileLineItems` REPAIR Rate/Qty in code rather than asking the
    // model to reason its way to the right column (which is what corrupted
    // ItemNo previously).
    UOM: { type: 'STRING', nullable: true },
    LineAmount: { type: 'NUMBER', nullable: true },
    RowCells: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          Header: { type: 'STRING', nullable: true },
          Value: { type: 'NUMBER', nullable: true },
        },
        required: ['Header', 'Value'],
      },
    },
  },
  // All fields REQUIRED so Gemini always emits the keys (as null when absent).
  // Nullable-but-optional fields are silently dropped from the output.
  required: [
    'ItemNo',
    'ItemDesc',
    'Rate',
    'Qty',
    'Weight',
    'BatchNo',
    'UOM',
    'LineAmount',
    'RowCells',
  ],
} as const;

// One purchase order and every line clubbed under it. Lines sharing a PONo go
// into the SAME order; lines with no PO share a single PONo:null order.
const GOODS_ORDER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    PONo: { type: 'STRING', nullable: true },
    Items: { type: 'ARRAY', items: GOODS_ITEM_SCHEMA },
  },
  // PONo must be REQUIRED so Gemini always emits the key (as null when the
  // document has no PO). A nullable-but-optional field is silently dropped
  // from the output, which is why PONo went missing entirely.
  required: ['PONo', 'Items'],
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
    EWayBillNo: { type: 'STRING', nullable: true },
    EWayBillDate: { type: 'STRING', nullable: true },
    Orders: { type: 'ARRAY', items: GOODS_ORDER_SCHEMA },
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
- A tax invoice followed by its e-Way Bill / delivery challan for the SAME transaction is ONE document — MERGE them: take line items and amounts from the invoice, and fill VehicleNo / LRNo / Transporter / EWayBillNo / EWayBillDate from the e-Way Bill or challan page.
- Unrelated documents (different suppliers, different transactions) are SEPARATE documents.

STEP 2 — CLASSIFY each document's docType: TAX_INVOICE, DELIVERY_CHALLAN, EWAY_BILL, PAYMENT_ADVICE, or OTHER.

STEP 3 — EXTRACT into the schema (field names are case-sensitive — use them EXACTLY as written):
For goods documents (TAX_INVOICE / DELIVERY_CHALLAN / EWAY_BILL) fill "goods" and set "paymentAdvice" to null:
- Supplier / SupplierGSTNo: the issuing seller and its GSTIN.
- InvoiceNo + InvoiceDate, and ChallanNo + ChallanDate if a separate challan number/date is printed (else null).
- VehicleNo, LRNo (L.R. No.), Transporter (transporter / transport company name) — often on the e-Way Bill / dispatch section of a merged document. Always fill Transporter when any carrier / transport name is printed.
- EWayBillNo (E-Way Bill number, usually a 12-digit number; labels: "e-Way Bill No", "EWB No", "eWay Bill No") and EWayBillDate (its date) — from the e-Way Bill page/section. Use null if not present.
- Orders[]: group EVERY line item by its purchase / order number. Lines that share the SAME PO number belong to ONE order object; do NOT create a separate order per line when the PO repeats. Each order has:
  - PONo: the purchase / order number for that group (labels: "PO No", "PO. No.", "Order No", "Order No1", "Buyer's Order No.", "Buyer Order No."). If a single PO covers the whole document, return ONE order holding all items. Lines with no PO printed go into a single order with PONo = null.
  - Items[]: the lines under that PO, each with:
    - ItemNo: item / part code (as string).
    - ItemDesc: the goods description.
    - Rate: per-unit price (numeric).
    - Qty: quantity (numeric) — the COUNT of physical units shipped (the "No Of Bundle" / "Qty Of Sheets" / "Qty" / "Pcs" column). Take the count column that is non-zero for this line. This is the piece count, NOT the weight, even when the line is billed PER KG.
    - Weight: the line's weight if the table prints a weight column ("Weight", "Wt", "Kgs"), else null. Report it as printed; it is a separate figure from Qty.
    - BatchNo: lot / batch number if present, else null.
    - UOM: the line's unit of measure EXACTLY as printed ("PER KG", "KG", "PCS", "NOS", "MT"), else null.
    - LineAmount: the money figure printed on that line in its own amount column ("Amount" / "Value" / "Taxable Value"), else null.
    - RowCells: TRANSCRIBE every numeric cell of that line as {Header, Value} pairs — Header is that column's heading text copied EXACTLY as printed ("Rate", "Weight", "No Of Bundle", "Qty Of Sheets", "Amount"), Value is the number in that column on this line. Include the amount column itself. Copy both verbatim: do not rename a header, do not judge which column means what, do not omit or merge any numeric column. Item codes and batch numbers are excluded; every other number on the row is included. This is transcription, NOT interpretation.
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
  if (!GEMINI_API_KEY) {
    throw new Error(
      'Gemini API key is missing. Set EXPO_PUBLIC_GEMINI_KEY in .env and restart with `npx expo start -c`.',
    );
  }

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
        // maxOutputTokens is a CEILING, not a reservation — Gemini only bills
        // for tokens actually generated, so there's no cost to requesting the
        // full window. Use the model's max (65536) so dense documents with many
        // line items don't truncate mid-JSON and trip the MAX_TOKENS error.
        maxOutputTokens: 65536,
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

// ── Line-item reconciliation ──────────────────────────────────────────────────
// Indian line tables carry several numeric columns ("No Of Bundle", "Qty Of
// Sheets", "Weight", "Rate", "Amount"). Gemini routinely picks the wrong one as
// Qty — and this is NOT a scan-quality problem: it misreads crisp text PDFs just
// as often (verified 2026-08-31 across degraded JPEG, crisp JPEG and text PDF).
//
// Two traps make this harder than it looks:
//  1. Multiplication is commutative, so checking Rate x Qty against the printed
//     amount can never detect a SWAP — 724 x 96 and 96 x 724 both give 69504.
//  2. Column ORDER is not reliable either. Some layouts print
//     "Weight | Rate | Amount", others "Rate | Weight | Amount", so "the column
//     before the amount is the Rate" silently inverts Rate and Qty.
//
// So we key off the COLUMN HEADER the model transcribes alongside each number,
// which is layout-independent, and use arithmetic only to confirm.

const TOLERANCE_REL = 0.01; // 1% — absorbs rounding and small line discounts
const TOLERANCE_ABS = 1; // rupee floor for tiny lines

const RATE_HEADER = /\b(rate|price|unit\s*price|per\s*unit)\b/i;
const AMOUNT_HEADER = /\b(amount|value|taxable|total)\b/i;
const WEIGHT_HEADER = /\b(weight|wt|kgs?|mts?|tons?|qty\s*in\s*kg)\b/i;
// Countable columns: how many physical units shipped. "No Of Bundle" and
// "Qty Of Sheets" both live here — an invoice often prints several, with the
// ones that do not apply to the line left at 0.
const COUNT_HEADER =
  /\b(qty|quantity|pcs|nos|sheets?|pieces?|units?|bundles?|cases?|cartons?|packets?|bags?|rolls?|boxes|box)\b/i;

interface RowCell {
  header: string;
  value: number;
}

function closeTo(value: number, target: number): boolean {
  return (
    Math.abs(value - target) <=
    Math.max(TOLERANCE_ABS, Math.abs(target) * TOLERANCE_REL)
  );
}

/** Normalise the model's transcribed cells, dropping anything unusable. */
function rowCells(input: unknown): RowCell[] {
  if (!Array.isArray(input)) return [];
  const out: RowCell[] = [];
  for (const c of input) {
    const value = typeof c?.Value === 'number' ? c.Value : Number(c?.Value);
    if (!Number.isFinite(value)) continue;
    out.push({ header: typeof c?.Header === 'string' ? c.Header : '', value });
  }
  return out;
}

/** First cell whose header matches `re` and which is not the amount column. */
function findCell(cells: RowCell[], re: RegExp): RowCell | null {
  return (
    cells.find((c) => re.test(c.header) && !AMOUNT_HEADER.test(c.header)) ??
    null
  );
}

/**
 * Repair one line's Rate/Qty against the amount printed on that same line.
 *
 * Strategy, strongest signal first:
 *   1. Column headers — "Rate" is Rate; the quantity column is chosen by UOM
 *      (weight UOM -> the weight column, piece UOM -> the count column).
 *      Confirmed by arithmetic against the printed amount.
 *   2. Arithmetic pair search, with the header naming which of the pair is Rate.
 *   3. Derive whichever single value is missing from the printed amount.
 *
 * Returns the item UNCHANGED whenever the evidence is insufficient — this is a
 * corrective pass, never a creative one.
 */
function reconcileItem(item: any): any {
  const amount = typeof item?.LineAmount === 'number' ? item.LineAmount : null;
  const rate = typeof item?.Rate === 'number' ? item.Rate : null;
  const qty = typeof item?.Qty === 'number' ? item.Qty : null;
  const cells = rowCells(item?.RowCells);
  const uom = typeof item?.UOM === 'string' ? item.UOM : '';

  // The weight column, when the table prints one, is reported alongside Qty
  // rather than replacing it — Qty is a piece count, Weight is kilograms.
  const printedWeight = findCell(cells, WEIGHT_HEADER)?.value ?? null;
  const weight = typeof item?.Weight === 'number' ? item.Weight : printedWeight;

  const apply = (nextRate: number, nextQty: number, why: string) => {
    if (nextRate !== rate || nextQty !== qty) {
      console.log(
        `[OCR] line reconciled (${why}) "${item?.ItemDesc ?? ''}": ` +
          `Rate ${rate} -> ${nextRate}, Qty ${qty} -> ${nextQty}` +
          (weight != null ? `, Weight ${weight}` : ''),
      );
    }
    return { ...item, Rate: nextRate, Qty: nextQty, Weight: weight };
  };

  // ── 1. Header-driven (layout-independent, the reliable path) ───────────────
  // Qty is the COUNT of physical units shipped ("No Of Bundle" / "Qty Of
  // Sheets"), NOT the weight — even when the line is billed PER KG. Invoices
  // print several count columns and zero the ones that do not apply, so take
  // the first non-zero one in printed order.
  const rateCell = findCell(cells, RATE_HEADER);
  const weightCell = findCell(cells, WEIGHT_HEADER);
  const countCell =
    cells.find(
      (c) =>
        COUNT_HEADER.test(c.header) &&
        !WEIGHT_HEADER.test(c.header) &&
        !AMOUNT_HEADER.test(c.header) &&
        c.value !== 0,
    ) ?? null;

  // Only when the document prints no count column at all does the weight become
  // the quantity — that is the billed quantity by default on a per-kg line.
  const qtyCell = countCell ?? weightCell;

  if (rateCell && qtyCell && rateCell !== qtyCell) {
    // Verify the RATE against the printed amount using the weight (that is what
    // a PER KG rate multiplies). This still catches a misread Rate even though
    // Rate x Qty deliberately no longer reconciles on bundle-counted lines.
    if (amount != null && Math.abs(amount) >= 0.005) {
      const basis = weightCell && countCell ? weightCell.value : qtyCell.value;
      if (basis !== 0 && !closeTo(rateCell.value * basis, amount)) {
        console.log(
          `[OCR] rate check FAILED "${item?.ItemDesc ?? ''}": ` +
            `${rateCell.value} x ${basis} != ${amount}`,
        );
      }
    }
    return apply(rateCell.value, qtyCell.value, 'headers');
  }

  // Everything below needs a printed amount to verify against. A zero amount is
  // matched trivially by any pair, so it proves nothing.
  if (amount == null || Math.abs(amount) < 0.005)
    return { ...item, Weight: weight };

  // ── 2. Arithmetic pair search; header decides which one is the Rate ────────
  const factors = cells.filter((c) => !AMOUNT_HEADER.test(c.header));
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const a = factors[i];
      const b = factors[j];
      if (a.value === 0 || b.value === 0) continue; // placeholder column
      if (!closeTo(a.value * b.value, amount)) continue;

      const aIsRate = RATE_HEADER.test(a.header);
      const bIsRate = RATE_HEADER.test(b.header);
      if (aIsRate && !bIsRate) return apply(a.value, b.value, 'pair+header');
      if (bIsRate && !aIsRate) return apply(b.value, a.value, 'pair+header');

      // No header hint: fall back to printed order — in most Indian layouts the
      // Rate sits nearer the amount column than the quantity does.
      return apply(b.value, a.value, 'pair+position');
    }
  }

  // ── 3. Derive a single missing value from the printed amount ──────────────
  if (rate != null && qty == null && Math.abs(rate) > 0.005) {
    return apply(rate, amount / rate, 'derived Qty');
  }
  if (qty != null && rate == null && Math.abs(qty) > 0.005) {
    return apply(amount / qty, qty, 'derived Rate');
  }

  if (rate != null && qty != null && !closeTo(rate * qty, amount)) {
    console.log(
      `[OCR] line NOT reconciled "${item?.ItemDesc ?? ''}": ` +
        `${rate} x ${qty} = ${rate * qty}, printed amount ${amount}`,
    );
  }
  return { ...item, Weight: weight };
}

/** Normalise a raw Gemini document object into a complete ExtractedDocument. */
function normaliseDocument(
  raw: Partial<ExtractedDocument>,
  imageUris: string[],
): ExtractedDocument {
  const docType = (raw.docType ?? 'OTHER') as DocType;
  const goods = raw.goods
    ? {
        ...raw.goods,
        // Stamp each line with its parent order's PONo so every item carries the
        // PO (derived — always equals the order's PONo).
        Orders: (raw.goods.Orders ?? []).map((o: any) => ({
          ...o,
          Items: (o?.Items ?? []).map((it: any) => ({
            ...reconcileItem(it),
            PONo: o?.PONo ?? null,
          })),
        })),
      }
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
