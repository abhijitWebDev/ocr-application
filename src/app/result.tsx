// app/result.tsx
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatINR } from '../utils/Invoiceparser';
import {
  docDate,
  docLineCount,
  docRef,
  docTitle,
  docTotal,
  goodsOrders,
  stripLineAids,
  lineAmount,
  type ExtractedDocument,
  type ExtractionResult,
  type GoodsDoc,
  type GoodsItem,
} from '../utils/Schema';
import { clearPendingResult, getPendingResult, getSettings } from '../utils/Storage';
import { Colors, invoiceTypeColors, invoiceTypeLabels } from '../utils/Theme';

function cleanExport(doc: ExtractedDocument): object {
  if (doc.docType === 'PAYMENT_ADVICE') return doc.paymentAdvice ?? {};
  const g = doc.goods;
  if (!g) return {};
  const orders = goodsOrders(g);
  const distinctPOs = new Set(orders.map((o) => o.PONo).filter((p): p is string => !!p));
  // Single PO (or none) covers the document: drop the Orders[] wrapper and emit a
  // flat Items[] with the PO stamped on every line. Only keep the grouped
  // Orders[] shape when the document actually spans multiple distinct POs.
  if (distinctPOs.size <= 1) {
    const { Orders, ...rest } = g as GoodsDoc & { Orders?: unknown };
    return { ...rest, Items: orders.flatMap((o) => o.Items.map(stripLineAids)) };
  }
  // Grouped shape: strip the internal reconciliation aids off every line so the
  // exported payload stays exactly the caller's PascalCase contract.
  return {
    ...g,
    Orders: orders.map((o) => ({ ...o, Items: o.Items.map(stripLineAids) })),
  };
}

function buildShareText(doc: ExtractedDocument): string {
  const label = invoiceTypeLabels[doc.docType] || 'Document';
  if (doc.docType === 'PAYMENT_ADVICE' && doc.paymentAdvice) {
    const p = doc.paymentAdvice;
    return [
      `${label} — ${p.Payer || ''}`,
      p.PaymentRef ? `UTR: ${p.PaymentRef}` : '',
      p.PaymentDate ? `Date: ${p.PaymentDate}` : '',
      `References: ${p.References?.length ?? 0}`,
      `TOTAL: ${formatINR(p.GrandTotal)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const g = doc.goods;
  return [
    `${label} — ${g?.Supplier || ''}`,
    g?.InvoiceNo ? `Invoice #: ${g.InvoiceNo}` : '',
    g?.ChallanNo ? `Challan #: ${g.ChallanNo}` : '',
    g?.InvoiceDate ? `Date: ${g.InvoiceDate}` : '',
    g?.Transporter ? `Transporter: ${g.Transporter}` : '',
    g?.EWayBillNo ? `EWay Bill #: ${g.EWayBillNo}` : '',
    g?.EWayBillDate ? `EWay Bill Date: ${g.EWayBillDate}` : '',
    '',
    ...goodsOrders(g).flatMap((o) => [
      `PO: ${o.PONo || '—'}`,
      ...o.Items.map(
        (i) =>
          `  • ${i.ItemDesc} (${i.Qty ?? ''}` +
          `${i.Weight != null ? `, ${i.Weight} kg` : ''}) — ${formatINR(lineAmount(i))}`,
      ),
    ]),
    '',
    `TOTAL: ${formatINR(docTotal(doc))}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export default function ResultScreen() {
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [jsonExpanded, setJsonExpanded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    getPendingResult().then((r) => {
      if (r) setResult(r);
    });
    return () => {
      clearPendingResult();
    };
  }, []);

  if (!result || result.documents.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={Colors.accent} size="large" />
      </View>
    );
  }

  const docs = result.documents;
  const doc = docs[Math.min(activeIdx, docs.length - 1)];
  const typeColor = invoiceTypeColors[doc.docType] || Colors.accent;
  const exportJson = cleanExport(doc);
  const sourceUri = doc.imageUris?.[0];
  const showImage = sourceUri && !sourceUri.toLowerCase().includes('.pdf');

  const handleShare = async () => {
    await Share.share({ message: buildShareText(doc), title: 'Document Summary' });
  };

  const handleSave = async () => {
    const settings = await getSettings();
    const saveUrl = settings.saveUrl?.trim();
    const username = settings.username;
    if (!saveUrl) {
      Alert.alert('No Save URL', 'Go to Settings and enter a save URL first.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => router.push('/settings' as any) },
      ]);
      return;
    }
    // Normalise the saved URL to the ASMX HTTP-POST endpoint (method name in the
    // path). Otherwise the request hits the SOAP handler, which rejects the
    // form-urlencoded body with "Data at the root level is invalid":
    //   ".../WebService.asmx?op=GET_OCR_Data" -> ".../WebService.asmx/GET_OCR_Data" (help-page URL)
    //   ".../WebService.asmx"                 -> ".../WebService.asmx/GET_OCR_Data" (base URL)
    let postUrl = saveUrl.replace(/\/+$/, '');
    const opMatch = postUrl.match(/^(.*\.asmx)\?op=(\w+)/i);
    if (opMatch) {
      postUrl = `${opMatch[1]}/${opMatch[2]}`;
    } else if (/\.asmx$/i.test(postUrl)) {
      postUrl = `${postUrl}/GET_OCR_Data`;
    }
    setIsSaving(true);
    try {
      // POST one document per request as x-www-form-urlencoded, matching the
      // ASMX endpoint (GET_OCR_Data): JsonData + username + DocType. The service
      // replies with XML (<string>…</string>), so we only check the HTTP status.
      let sent = 0;
      for (const d of docs) {
        const body =
          `JsonData=${encodeURIComponent(JSON.stringify(cleanExport(d)))}` +
          `&username=${encodeURIComponent(username ?? '')}` +
          `&DocType=${encodeURIComponent(d.docType)}`;
        const response = await fetch(postUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!response.ok) {
          const serverText = await response.text().catch(() => '');
          throw new Error(
            `Document ${sent + 1} of ${docs.length} failed (${response.status}).` +
              (serverText ? `\n\n${serverText.slice(0, 300)}` : ''),
          );
        }
        sent += 1;
      }
      Alert.alert(
        'Saved',
        `${sent} document${sent > 1 ? 's' : ''} sent to the server.`,
      );
    } catch (err: any) {
      Alert.alert('Save Failed', err.message || 'Could not reach the server.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerInvoiceNo} numberOfLines={1}>
            {docRef(doc) || 'SCAN RESULT'}
          </Text>
          {docDate(doc) && <Text style={styles.headerDate}>{docDate(doc)}</Text>}
        </View>
        <TouchableOpacity onPress={handleShare} style={styles.headerBtn}>
          <Ionicons name="share-outline" size={22} color={Colors.accent} />
        </TouchableOpacity>
      </View>

      {/* Document selector (multi-document scans) */}
      {docs.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.docTabs}
          contentContainerStyle={styles.docTabsContent}
        >
          {docs.map((d, i) => {
            const active = i === activeIdx;
            const color = invoiceTypeColors[d.docType] || Colors.accent;
            return (
              <TouchableOpacity
                key={d.id}
                onPress={() => setActiveIdx(i)}
                style={[
                  styles.docTab,
                  {
                    borderColor: active ? color : Colors.border,
                    backgroundColor: active ? color + '1A' : Colors.bgCard,
                  },
                ]}
                activeOpacity={0.8}
              >
                <Text style={[styles.docTabType, { color }]} numberOfLines={1}>
                  {invoiceTypeLabels[d.docType] || 'Document'}
                </Text>
                <Text style={styles.docTabTitle} numberOfLines={1}>
                  {docTitle(d)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Summary pills */}
      <View style={styles.pillRow}>
        <Pill
          icon="layers-outline"
          color={typeColor}
          label={invoiceTypeLabels[doc.docType] || 'Document'}
        />
        <Pill
          icon="list-outline"
          color={Colors.accent}
          label={`${docLineCount(doc)} ${doc.docType === 'PAYMENT_ADVICE' ? 'refs' : 'items'}`}
        />
        {docTotal(doc) != null && (
          <Pill
            icon="cash-outline"
            color={Colors.amber}
            label={`${docTotal(doc)!.toLocaleString('en-IN')} INR`}
          />
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
      >
        {showImage && (
          <Image
            source={{ uri: sourceUri }}
            style={styles.sourceImage}
            contentFit="cover"
          />
        )}

        {doc.docType === 'PAYMENT_ADVICE'
          ? renderPaymentAdvice(doc)
          : renderGoods(doc, typeColor)}

        {/* Raw JSON */}
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.sectionHeader, { borderLeftColor: Colors.textMuted }]}
            onPress={() => setJsonExpanded((v) => !v)}
            activeOpacity={0.7}
          >
            <Ionicons name="code-slash-outline" size={14} color={Colors.textMuted} />
            <Text style={[styles.sectionTitle, { color: Colors.textMuted }]}>
              Raw JSON
            </Text>
            <Ionicons
              name={jsonExpanded ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={Colors.textMuted}
              style={{ marginLeft: 'auto' }}
            />
          </TouchableOpacity>
          {jsonExpanded && (
            <ScrollView style={styles.jsonScroll} nestedScrollEnabled showsVerticalScrollIndicator>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <Text style={styles.jsonText}>
                  {JSON.stringify(exportJson, null, 2)}
                </Text>
              </ScrollView>
            </ScrollView>
          )}
        </View>
      </ScrollView>

      {/* Save to Database */}
      <View style={[styles.saveBar, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity
          style={[styles.saveBtn, isSaving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={isSaving}
          activeOpacity={0.85}
        >
          <Ionicons name="save-outline" size={20} color={Colors.textInverse} />
          <Text style={styles.saveBtnText}>
            {isSaving
              ? 'Saving…'
              : docs.length > 1
                ? `Save ${docs.length} Documents`
                : 'Save to Database'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Renderers by docType ───────────────────────────────────────────────────────

// One goods line item. `showPO` controls whether the item's PONo is included in
// the meta row — true for the flat single-PO list, false when an order-group
// header already displays the PO.
function renderLineItem(
  item: GoodsItem,
  idx: number,
  isLast: boolean,
  showPO: boolean,
  typeColor: string,
) {
  return (
    <View key={idx} style={[styles.lineItem, isLast && { borderBottomWidth: 0 }]}>
      <View style={styles.lineItemLeft}>
        <View style={[styles.lineItemNum, { backgroundColor: typeColor + '22' }]}>
          <Text style={[styles.lineItemNumText, { color: typeColor }]}>{idx + 1}</Text>
        </View>
        <View style={styles.lineItemBody}>
          <Text style={styles.lineItemDesc}>{item.ItemDesc}</Text>
          <Text style={styles.lineItemMeta}>
            {[
              showPO && item.PONo ? `PO: ${item.PONo}` : null,
              item.Qty != null ? `Qty: ${item.Qty}` : null,
              item.Weight != null ? `Wt: ${item.Weight}` : null,
              item.Rate != null ? `@ ${formatINR(item.Rate)}` : null,
              item.ItemNo ? `Item: ${item.ItemNo}` : null,
              item.BatchNo ? `Batch: ${item.BatchNo}` : null,
            ]
              .filter(Boolean)
              .join('  ')}
          </Text>
        </View>
      </View>
      <Text style={styles.lineItemAmount}>{formatINR(lineAmount(item))}</Text>
    </View>
  );
}

function renderGoods(doc: ExtractedDocument, typeColor: string) {
  const g = doc.goods;
  if (!g) return null;
  const hasDispatch = !!(
    g.VehicleNo ||
    g.LRNo ||
    g.Transporter ||
    g.EWayBillNo ||
    g.EWayBillDate
  );
  const orders = goodsOrders(g);
  const itemCount = orders.reduce((n, o) => n + o.Items.length, 0);
  // Distinct non-null PO numbers across the document. When a single PO (or none)
  // covers every line, show a flat list with the PO on each line item instead of
  // an order-group header; only split into groups when the POs actually differ.
  const distinctPOs = new Set(orders.map((o) => o.PONo).filter((p): p is string => !!p));
  const singlePO = distinctPOs.size <= 1;
  return (
    <>
      <Section title="DOCUMENT INFO" icon="document-text-outline" color={Colors.accent}>
        <InfoRow label="Invoice No" value={g.InvoiceNo} mono />
        <InfoRow label="Invoice Date" value={g.InvoiceDate} />
        <InfoRow label="Challan No" value={g.ChallanNo} mono />
        <InfoRow label="Challan Date" value={g.ChallanDate} />
      </Section>

      {(g.Supplier || g.SupplierGSTNo) && (
        <Section title="SUPPLIER" icon="business-outline" color={Colors.info}>
          <InfoRow label="Name" value={g.Supplier} bold />
          <InfoRow label="GST No" value={g.SupplierGSTNo} mono />
        </Section>
      )}

      {hasDispatch && (
        <Section title="DISPATCH" icon="car-outline" color={Colors.textSecondary}>
          <InfoRow label="Vehicle No" value={g.VehicleNo} mono />
          <InfoRow label="LR No" value={g.LRNo} mono />
          <InfoRow label="Transporter" value={g.Transporter} />
          <InfoRow label="EWay Bill No" value={g.EWayBillNo} mono />
          <InfoRow label="EWay Bill Date" value={g.EWayBillDate} />
        </Section>
      )}

      {orders.length > 0 && (
        <Section
          title={`LINE ITEMS (${itemCount})`}
          icon="list-outline"
          color={Colors.accent}
        >
          {singlePO
            ? // Single PO (or none) — flat list with the PO shown on each line item.
              orders
                .flatMap((o) => o.Items)
                .map((item, idx, arr) =>
                  renderLineItem(item, idx, idx === arr.length - 1, true, typeColor),
                )
            : // Multiple distinct POs — group by order; header carries the PO.
              orders.map((order, oIdx) => (
                <View key={oIdx} style={oIdx > 0 && styles.orderGroup}>
                  <View style={styles.orderHeader}>
                    <Ionicons name="pricetag-outline" size={13} color={Colors.textSecondary} />
                    <Text style={styles.orderHeaderText}>
                      PO: {order.PONo || '—'}
                    </Text>
                    <Text style={styles.orderHeaderCount}>
                      {order.Items.length} {order.Items.length === 1 ? 'item' : 'items'}
                    </Text>
                  </View>
                  {order.Items.map((item, idx) =>
                    renderLineItem(item, idx, idx === order.Items.length - 1, false, typeColor),
                  )}
                </View>
              ))}
        </Section>
      )}

      {(g.TaxableValue != null ||
        g.CGSTAmount != null ||
        g.SGSTAmount != null ||
        g.IGSTAmount != null ||
        g.TotalTaxAmount != null ||
        g.InvoiceTotal != null) && (
        <Section title="TAX SUMMARY" icon="calculator-outline" color={Colors.info}>
          {g.TaxableValue != null && (
            <InfoRow label="Taxable Value" value={formatINR(g.TaxableValue)} />
          )}
          {g.CGSTAmount != null && (
            <InfoRow
              label={`CGST${g.CGSTRate != null ? ` @${g.CGSTRate}%` : ''}`}
              value={formatINR(g.CGSTAmount)}
            />
          )}
          {g.SGSTAmount != null && (
            <InfoRow
              label={`SGST${g.SGSTRate != null ? ` @${g.SGSTRate}%` : ''}`}
              value={formatINR(g.SGSTAmount)}
            />
          )}
          {g.IGSTAmount != null && (
            <InfoRow
              label={`IGST${g.IGSTRate != null ? ` @${g.IGSTRate}%` : ''}`}
              value={formatINR(g.IGSTAmount)}
            />
          )}
          {g.TotalTaxAmount != null && (
            <InfoRow label="Total Tax" value={formatINR(g.TotalTaxAmount)} />
          )}
          {g.RoundOff != null && (
            <InfoRow label="Round Off" value={formatINR(g.RoundOff)} />
          )}
          {g.InvoiceTotal != null && (
            <View style={styles.grandTotalRow}>
              <Text style={styles.grandTotalLabel}>Invoice Total</Text>
              <Text style={styles.grandTotalValue}>{formatINR(g.InvoiceTotal)}</Text>
            </View>
          )}
        </Section>
      )}
    </>
  );
}

function renderPaymentAdvice(doc: ExtractedDocument) {
  const p = doc.paymentAdvice;
  if (!p) return null;
  return (
    <>
      <Section title="PAYMENT INFO" icon="cash-outline" color={Colors.accent}>
        <InfoRow label="Payer" value={p.Payer} bold />
        <InfoRow label="UTR / Ref" value={p.PaymentRef} mono />
        <InfoRow label="Date" value={p.PaymentDate} />
        {p.GrandTotal != null && (
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Grand Total</Text>
            <Text style={styles.grandTotalValue}>{formatINR(p.GrandTotal)}</Text>
          </View>
        )}
      </Section>

      {(p.References?.length ?? 0) > 0 && (
        <Section
          title={`REFERENCES (${p.References.length})`}
          icon="list-outline"
          color={Colors.info}
        >
          {p.References.map((ref, idx) => (
            <View
              key={idx}
              style={[
                styles.lineItem,
                idx === p.References.length - 1 && { borderBottomWidth: 0 },
              ]}
            >
              <View style={styles.lineItemLeft}>
                <View style={styles.lineItemBody}>
                  <Text style={styles.lineItemDesc}>
                    {ref.DocNo || ref.GRNNo || ref.PONo || `Ref ${idx + 1}`}
                  </Text>
                  <Text style={styles.lineItemMeta}>
                    {[
                      ref.PONo ? `PO: ${ref.PONo}` : null,
                      ref.GRNNo ? `GRN: ${ref.GRNNo}` : null,
                      ref.DocDate,
                      ref.Deduction != null ? `TDS: ${formatINR(ref.Deduction)}` : null,
                    ]
                      .filter(Boolean)
                      .join('  ')}
                  </Text>
                </View>
              </View>
              <Text style={styles.lineItemAmount}>{formatINR(ref.Amount)}</Text>
            </View>
          ))}
        </Section>
      )}
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Pill({ icon, label, color }: { icon: string; label: string; color: string }) {
  return (
    <View style={[styles.pill, { borderColor: color + '55', backgroundColor: color + '11' }]}>
      <Ionicons name={icon as any} size={12} color={color} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function Section({
  title,
  icon,
  color,
  children,
}: {
  title: string;
  icon: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={[styles.sectionHeader, { borderLeftColor: color }]}>
        <Ionicons name={icon as any} size={14} color={color} />
        <Text style={[styles.sectionTitle, { color }]}>{title}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function InfoRow({
  label,
  value,
  mono,
  bold,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  bold?: boolean;
}) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text
        style={[styles.infoValue, mono && styles.infoMono, bold && styles.infoBold]}
        numberOfLines={3}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  centered: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.bgCard,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerInvoiceNo: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
    letterSpacing: 0.5,
  },
  headerDate: { fontSize: 12, color: Colors.textMuted, marginTop: 1 },

  docTabs: {
    maxHeight: 60,
    backgroundColor: Colors.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  docTabsContent: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  docTab: {
    minWidth: 120,
    maxWidth: 180,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
  },
  docTabType: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  docTabTitle: { fontSize: 12, color: Colors.textPrimary, marginTop: 1 },

  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Colors.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontWeight: '600' },

  scroll: { padding: 12, gap: 10 },

  sourceImage: {
    width: '100%',
    height: 180,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.bgCard,
  },

  section: {
    backgroundColor: Colors.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.bgElevated,
    borderLeftWidth: 3,
  },
  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  sectionBody: { padding: 14, gap: 10 },

  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  infoLabel: { fontSize: 13, color: Colors.textMuted, flex: 0.38 },
  infoValue: { fontSize: 13, color: Colors.textPrimary, flex: 0.62, textAlign: 'right' },
  infoMono: { fontFamily: 'monospace', fontSize: 12, color: Colors.textSecondary },
  infoBold: { fontWeight: '700' },

  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  grandTotalLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  grandTotalValue: { fontSize: 22, fontWeight: '800', color: Colors.amber },

  orderGroup: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  orderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 4,
  },
  orderHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textSecondary,
    letterSpacing: 0.3,
    flex: 1,
  },
  orderHeaderCount: { fontSize: 11, color: Colors.textMuted },

  lineItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  lineItemLeft: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, flex: 1 },
  lineItemNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  lineItemNumText: { fontSize: 11, fontWeight: '700' },
  lineItemBody: { flex: 1, gap: 3 },
  lineItemDesc: { fontSize: 13, color: Colors.textPrimary, fontWeight: '500' },
  lineItemMeta: { fontSize: 11, color: Colors.textMuted },
  lineItemAmount: { fontSize: 14, fontWeight: '700', color: Colors.accent, flexShrink: 0 },

  jsonScroll: { maxHeight: 500 },
  jsonText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: Colors.textSecondary,
    padding: 12,
    lineHeight: 17,
  },

  saveBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: Colors.bg,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    paddingVertical: 15,
    borderRadius: 14,
  },
  saveBtnText: { color: Colors.textInverse, fontWeight: '700', fontSize: 16 },
});
