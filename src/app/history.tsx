// app/history.tsx
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
    Alert,
    FlatList,
    RefreshControl,
    StyleSheet,
    Text,
    TextInput,
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
    type ExtractedDocument,
} from '../utils/Schema';
import {
    clearAll,
    deleteDocument,
    getAllDocuments,
    setPendingResult,
} from '../utils/Storage';
import { Colors, invoiceTypeColors, invoiceTypeLabels } from '../utils/Theme';

export default function HistoryScreen() {
  const [docs, setDocs] = useState<ExtractedDocument[]>([]);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const insets = useSafeAreaInsets();

  const load = async () => {
    const all = await getAllDocuments();
    setDocs(all);
  };

  // expo-router equivalent of useFocusEffect
  useFocusEffect(
    useCallback(() => {
      load();
    }, []),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openDocument = async (doc: ExtractedDocument) => {
    await setPendingResult({ documents: [doc] });
    router.push('/result');
  };

  const handleDelete = (id: string, name?: string | null) => {
    Alert.alert('Delete Document', `Remove "${name || 'this document'}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteDocument(id);
          load();
        },
      },
    ]);
  };

  const handleClearAll = () => {
    Alert.alert(
      'Clear All History',
      'This will permanently delete all scanned documents.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            await clearAll();
            setDocs([]);
          },
        },
      ],
    );
  };

  const totalValue = docs.reduce((sum, d) => sum + (docTotal(d) ?? 0), 0);

  const filtered = query.trim()
    ? docs.filter((d) => {
        const q = query.toLowerCase();
        return (
          docTitle(d).toLowerCase().includes(q) ||
          (docRef(d)?.toLowerCase().includes(q) ?? false)
        );
      })
    : docs;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>SCAN HISTORY</Text>
        {docs.length > 0 ? (
          <TouchableOpacity onPress={handleClearAll} style={styles.headerBtn}>
            <Ionicons name="trash-outline" size={20} color={Colors.error} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      {/* Stats bar */}
      {docs.length > 0 && (
        <View style={styles.statsBar}>
          <View style={styles.statChip}>
            <Ionicons name="scan-outline" size={14} color={Colors.accent} />
            <View>
              <Text style={styles.statLabel}>SCANS</Text>
              <Text style={styles.statValue}>{docs.length}</Text>
            </View>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statChip}>
            <Ionicons name="cash-outline" size={14} color={Colors.amber} />
            <View>
              <Text style={styles.statLabel}>TOTAL VALUE</Text>
              <Text style={[styles.statValue, { color: Colors.amber }]}>
                {formatINR(totalValue)}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Search bar */}
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={16} color={Colors.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or reference #"
          placeholderTextColor={Colors.textMuted}
          clearButtonMode="while-editing"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + 20 },
          docs.length === 0 && { flex: 1 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.accent}
            colors={[Colors.accent]}
          />
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={() => (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="scan-outline" size={48} color={Colors.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>No Scans Yet</Text>
            <Text style={styles.emptySub}>
              Scan your first document to see it here.
            </Text>
            <TouchableOpacity style={styles.emptyCTA} onPress={() => router.back()}>
              <Ionicons name="scan-outline" size={18} color={Colors.textInverse} />
              <Text style={styles.emptyCTAText}>Start Scanning</Text>
            </TouchableOpacity>
          </View>
        )}
        renderItem={({ item }) => {
          const color = invoiceTypeColors[item.docType] || Colors.accent;
          const lineCount = docLineCount(item);
          const total = docTotal(item);
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => openDocument(item)}
              activeOpacity={0.7}
            >
              <View style={[styles.cardAccent, { backgroundColor: color }]} />
              <View style={styles.cardBody}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardVendor} numberOfLines={1}>
                      {docTitle(item)}
                    </Text>
                    <View style={[styles.cardBadge, { backgroundColor: color + '22' }]}>
                      <Text style={[styles.cardBadgeText, { color }]}>
                        {invoiceTypeLabels[item.docType] || 'Document'}
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDelete(item.id, docTitle(item))}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Ionicons name="close-circle-outline" size={20} color={Colors.textMuted} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.cardMeta}>
                  {[
                    docRef(item) && `#${docRef(item)}`,
                    docDate(item),
                    lineCount
                      ? `${lineCount} ${item.docType === 'PAYMENT_ADVICE' ? 'ref' : 'item'}${lineCount !== 1 ? 's' : ''}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>

                <View style={styles.cardBottom}>
                  <Text style={styles.cardTotal}>
                    {total != null ? formatINR(total) : 'No total'}
                  </Text>
                  <Text style={styles.cardDate}>
                    {new Date(item.scannedAt).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </Text>
                </View>
              </View>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={Colors.textMuted}
                style={{ alignSelf: 'center', marginRight: 12 }}
              />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    color: Colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
  },

  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    padding: 12,
    paddingHorizontal: 20,
    backgroundColor: Colors.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  statChip: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statDivider: { width: 1, height: 28, backgroundColor: Colors.border },
  statLabel: { fontSize: 10, color: Colors.textMuted, letterSpacing: 0.5 },
  statValue: { fontSize: 15, color: Colors.accent, fontWeight: '700' },

  list: { padding: 16 },

  card: {
    flexDirection: 'row',
    backgroundColor: Colors.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  cardAccent: { width: 3 },
  cardBody: { flex: 1, padding: 12, gap: 5 },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  cardVendor: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 3,
  },
  cardBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  cardBadgeText: { fontSize: 10, fontWeight: '500' },
  cardMeta: { fontSize: 11, color: Colors.textMuted },
  cardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTotal: { fontSize: 15, color: Colors.amber, fontWeight: '700' },
  cardDate: { fontSize: 10, color: Colors.textMuted },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary },
  emptySub: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  emptyCTA: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
    marginTop: 8,
  },
  emptyCTAText: { color: Colors.textInverse, fontWeight: '700', fontSize: 15 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginVertical: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 8,
  },
  searchIcon: { flexShrink: 0 },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
});
