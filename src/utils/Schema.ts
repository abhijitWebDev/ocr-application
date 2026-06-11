// src/utils/Schema.ts
// ── Multi-document extraction envelope ────────────────────────────────────────
// One scan can yield several documents (multi-page single doc, an invoice +
// its e-way bill merged, or a batch of separate docs). Every document carries
// EITHER a `goods` payload OR a `paymentAdvice` payload — discriminated by
// `docType`. Both fields are nullable so we never depend on Gemini union support.
//
// The `goods` / `paymentAdvice` field names use the caller's canonical
// PascalCase contract verbatim — this is exactly what gets exported / POSTed.

export type DocType =
  | 'TAX_INVOICE'
  | 'DELIVERY_CHALLAN'
  | 'EWAY_BILL'
  | 'PAYMENT_ADVICE'
  | 'OTHER';

export const GOODS_TYPES: DocType[] = [
  'TAX_INVOICE',
  'DELIVERY_CHALLAN',
  'EWAY_BILL',
];

export interface GoodsItem {
  PONo: string | null;
  ItemNo: string | null;
  ItemDesc: string;
  Rate: number | null;
  Qty: number | null;
  BatchNo: string | null;
}

export interface GoodsDoc {
  Supplier: string | null;
  SupplierGSTNo: string | null;
  ChallanNo: string | null;
  ChallanDate: string | null;
  InvoiceNo: string | null;
  InvoiceDate: string | null;
  VehicleNo: string | null;
  LRNo: string | null;
  Transporter: string | null;
  Items: GoodsItem[];
}

export interface PaymentReference {
  PONo: string | null;
  DocNo: string | null;
  DocDate: string | null;
  GRNNo: string | null;
  InvoiceAmount: number | null;
  Deduction: number | null;
  Amount: number | null;
}

export interface PaymentAdviceDoc {
  Payer: string | null;
  PaymentRef: string | null; // UTR / instrument no
  PaymentDate: string | null;
  GrandTotal: number | null;
  References: PaymentReference[];
}

export interface ExtractedDocument {
  id: string;
  scannedAt: string;
  docType: DocType;
  imageUris?: string[];
  goods: GoodsDoc | null;
  paymentAdvice: PaymentAdviceDoc | null;
  rawText: string;
}

export interface ExtractionResult {
  documents: ExtractedDocument[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Best-effort display title for a document (supplier/payer fallback chain). */
export function docTitle(doc: ExtractedDocument): string {
  if (doc.goods?.Supplier) return doc.goods.Supplier;
  if (doc.paymentAdvice?.Payer) return doc.paymentAdvice.Payer;
  return 'Unknown';
}

/**
 * Headline monetary value for display only (NOT part of the exported JSON).
 * Goods totals are derived from Rate × Qty since the contract has no amount field.
 */
export function docTotal(doc: ExtractedDocument): number | null {
  if (doc.goods) {
    const sum = (doc.goods.Items ?? []).reduce(
      (s, i) => s + (i.Rate ?? 0) * (i.Qty ?? 0),
      0,
    );
    return sum > 0 ? sum : null;
  }
  if (doc.paymentAdvice) return doc.paymentAdvice.GrandTotal;
  return null;
}

/** Per-line display amount (Rate × Qty) — display only, not exported. */
export function lineAmount(item: GoodsItem): number | null {
  if (item.Rate != null && item.Qty != null) return item.Rate * item.Qty;
  return item.Rate ?? null;
}

/** Primary reference number shown in lists / headers. */
export function docRef(doc: ExtractedDocument): string | null {
  if (doc.goods) return doc.goods.InvoiceNo ?? doc.goods.ChallanNo;
  if (doc.paymentAdvice) return doc.paymentAdvice.PaymentRef;
  return null;
}

/** Source date string for a document, regardless of type. */
export function docDate(doc: ExtractedDocument): string | null {
  if (doc.goods) return doc.goods.InvoiceDate ?? doc.goods.ChallanDate;
  if (doc.paymentAdvice) return doc.paymentAdvice.PaymentDate;
  return null;
}

/** Item / reference-row count for compact summaries. */
export function docLineCount(doc: ExtractedDocument): number {
  if (doc.goods) return doc.goods.Items?.length ?? 0;
  if (doc.paymentAdvice) return doc.paymentAdvice.References?.length ?? 0;
  return 0;
}

/** Strip the heavy rawText field before persisting to history. */
export function stripRawText(doc: ExtractedDocument): ExtractedDocument {
  return { ...doc, rawText: '' };
}
