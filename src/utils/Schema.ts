// src/utils/Schema.ts
// ── Multi-document extraction envelope ────────────────────────────────────────
// One scan can yield several documents (multi-page single doc, an invoice +
// its e-way bill merged, or a batch of separate docs). Every document carries
// EITHER a `goods` payload OR a `paymentAdvice` payload — discriminated by
// `docType`. Both fields are nullable so we never depend on Gemini union support.

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
  itemNo: string | null;
  itemDesc: string;
  hsnCode: string | null;
  qty: number | null;
  unit: string | null;
  rate: number | null;
  amount: number | null;
  batchNo: string | null;
}

export interface GoodsDoc {
  supplier: string | null;
  supplierGSTNo: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  challanNo: string | null;
  challanDate: string | null;
  poNo: string | null; // header-level (one per document)
  eWayBillNo: string | null;
  vehicleNo: string | null;
  lrNo: string | null;
  transporter: string | null;
  items: GoodsItem[];
  taxableValue: number | null;
  taxAmount: number | null;
  invoiceTotal: number | null;
}

export interface PaymentRef {
  poNo: string | null;
  docNo: string | null;
  docDate: string | null;
  grnNo: string | null;
  invoiceAmount: number | null;
  deduction: number | null;
  amount: number | null;
}

export interface PaymentAdviceDoc {
  payer: string | null;
  paymentRef: string | null; // UTR / instrument no
  paymentDate: string | null;
  grandTotal: number | null;
  references: PaymentRef[];
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

/** Best-effort display title for a document (vendor/payer fallback chain). */
export function docTitle(doc: ExtractedDocument): string {
  if (doc.goods?.supplier) return doc.goods.supplier;
  if (doc.paymentAdvice?.payer) return doc.paymentAdvice.payer;
  return 'Unknown';
}

/** Headline monetary value for a document, regardless of type. */
export function docTotal(doc: ExtractedDocument): number | null {
  if (doc.goods) return doc.goods.invoiceTotal;
  if (doc.paymentAdvice) return doc.paymentAdvice.grandTotal;
  return null;
}

/** Primary reference number shown in lists / headers. */
export function docRef(doc: ExtractedDocument): string | null {
  if (doc.goods) return doc.goods.invoiceNo ?? doc.goods.challanNo;
  if (doc.paymentAdvice) return doc.paymentAdvice.paymentRef;
  return null;
}

/** Source date string for a document, regardless of type. */
export function docDate(doc: ExtractedDocument): string | null {
  if (doc.goods) return doc.goods.invoiceDate ?? doc.goods.challanDate;
  if (doc.paymentAdvice) return doc.paymentAdvice.paymentDate;
  return null;
}

/** Item / reference-row count for compact summaries. */
export function docLineCount(doc: ExtractedDocument): number {
  if (doc.goods) return doc.goods.items?.length ?? 0;
  if (doc.paymentAdvice) return doc.paymentAdvice.references?.length ?? 0;
  return 0;
}

/** Strip the heavy rawText field before persisting to history. */
export function stripRawText(doc: ExtractedDocument): ExtractedDocument {
  return { ...doc, rawText: '' };
}
