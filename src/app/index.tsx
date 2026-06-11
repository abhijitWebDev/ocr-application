// app/index.tsx
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  performExtraction,
  type ScanInput,
} from '../utils/Ocrservice';
import { saveDocuments, setPendingResult } from '../utils/Storage';
import { Colors } from '../utils/Theme';

const { height } = Dimensions.get('window');
const SCAN_LINE_TRAVEL = height;

function mimeFromUri(uri: string): string {
  if (/\.png($|\?)/i.test(uri)) return 'image/png';
  if (/\.webp($|\?)/i.test(uri)) return 'image/webp';
  return 'image/jpeg';
}

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [isScanning, setIsScanning] = useState(false);
  const [flashMode, setFlashMode] = useState<'on' | 'off'>('off');
  const [scanStatus, setScanStatus] = useState('');
  const [pages, setPages] = useState<ScanInput[]>([]);
  const cameraRef = useRef<CameraView>(null);
  const insets = useSafeAreaInsets();

  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!isScanning) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scanLineAnim, {
            toValue: SCAN_LINE_TRAVEL,
            duration: 2000,
            useNativeDriver: true,
          }),
          Animated.timing(scanLineAnim, {
            toValue: 0,
            duration: 2000,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    }
  }, [isScanning]);

  useEffect(() => {
    if (isScanning) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.5,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [isScanning]);

  // ── Tray management ────────────────────────────────────────────────────────
  const addPages = (inputs: ScanInput[]) => {
    if (inputs.length) setPages((prev) => [...prev, ...inputs]);
  };
  const removePage = (idx: number) =>
    setPages((prev) => prev.filter((_, i) => i !== idx));

  // ── Extraction pipeline (all pages in one pass) ────────────────────────────
  const runScan = async () => {
    if (pages.length === 0 || isScanning) return;
    try {
      setIsScanning(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      setScanStatus('Analyzing documents…');
      const result = await performExtraction(pages);

      if (result.documents.length === 0) {
        throw new Error('No documents detected. Try clearer images.');
      }

      setScanStatus('Saving…');
      await saveDocuments(result.documents);
      await setPendingResult(result);

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPages([]);
      router.push('/result');
    } catch (err: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Scan Failed', err.message || 'Try again with better lighting.');
    } finally {
      setIsScanning(false);
      setScanStatus('');
    }
  };

  // ── Input handlers (each appends to the tray) ──────────────────────────────
  const takePicture = async () => {
    if (!cameraRef.current || isScanning) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) {
        addPages([{ uri: photo.uri, mime: 'image/jpeg' }]);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {
      Alert.alert('Camera Error', 'Failed to capture photo. Please try again.');
    }
  };

  const pickFromGallery = async () => {
    if (isScanning) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      quality: 1,
      allowsMultipleSelection: true,
    });
    if (!result.canceled) {
      addPages(
        result.assets.map((a) => ({
          uri: a.uri,
          mime: a.mimeType ?? mimeFromUri(a.uri),
        })),
      );
    }
  };

  const pickFromDocuments = async () => {
    if (isScanning) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true, // ensures a readable file:// URI
        multiple: true,
      });
      if (!result.canceled && result.assets?.length) {
        addPages(
          result.assets.map((a) => ({ uri: a.uri, mime: 'application/pdf' })),
        );
      }
    } catch {
      Alert.alert('Document Error', 'Could not open the PDF. Please try again.');
    }
  };

  // ── Permission screens ──────────────────────────────────────────────────────
  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.centered]}>
        <LinearGradient
          colors={['#0A0A0F', '#13131A']}
          style={StyleSheet.absoluteFill}
        />
        <Ionicons name="camera-outline" size={64} color={Colors.accent} />
        <Text style={styles.permTitle}>Camera Access Required</Text>
        <Text style={styles.permSub}>
          Receipt Scanner needs camera access to scan and analyze your invoices.
        </Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Grant Permission</Text>
        </TouchableOpacity>

        {/* Allow PDF upload even without camera permission */}
        <TouchableOpacity
          style={[styles.permBtn, styles.permBtnSecondary]}
          onPress={pickFromDocuments}
        >
          <Ionicons
            name="document-outline"
            size={16}
            color={Colors.accent}
            style={{ marginRight: 6 }}
          />
          <Text style={[styles.permBtnText, { color: Colors.accent }]}>
            Upload PDF Instead
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main scanner UI ───────────────────────────────────────────────────────────
  const pageLabel = pages.length === 1 ? 'page' : 'pages';

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        flash={flashMode}
      />

      {/* Full-screen scan frame — corners at screen edges */}
      <View style={styles.scanFrame}>
        <View style={[styles.corner, styles.cornerTL]} />
        <View style={[styles.corner, styles.cornerTR]} />
        <View style={[styles.corner, styles.cornerBL]} />
        <View style={[styles.corner, styles.cornerBR]} />
        {!isScanning && (
          <Animated.View
            style={[
              styles.scanLine,
              { transform: [{ translateY: scanLineAnim }] },
            ]}
          />
        )}
        {isScanning && (
          <View style={styles.processingOverlay}>
            <Animated.View style={{ opacity: pulseAnim }}>
              <ActivityIndicator size="large" color={Colors.accent} />
            </Animated.View>
            <Text style={styles.processingText}>{scanStatus}</Text>
          </View>
        )}
      </View>

      {/* Top bar — absolute overlay */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => router.push('/history')}
          style={styles.topBtn}
          accessibilityLabel="Scan history"
        >
          <Ionicons name="time-outline" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>SCAN INVOICE</Text>
        <TouchableOpacity
          onPress={() => router.push('/settings' as any)}
          style={styles.topBtn}
          accessibilityLabel="Settings"
        >
          <Ionicons name="settings-outline" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Bottom controls — absolute overlay */}
      <View style={[styles.bottomControls, { paddingBottom: insets.bottom + 20 }]}>
        <Text style={styles.hintText}>
          {isScanning
            ? 'Processing…'
            : pages.length > 0
              ? `${pages.length} ${pageLabel} ready — add more or tap Scan`
              : 'Capture pages, then tap Scan — invoice, challan & e-way are merged'}
        </Text>

        {/* Captured-page tray */}
        {pages.length > 0 && (
          <ScrollView
            horizontal
            style={styles.tray}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trayContent}
          >
            {pages.map((p, i) => (
              <View key={`${p.uri}-${i}`} style={styles.thumb}>
                {p.mime === 'application/pdf' ? (
                  <View style={styles.thumbPdf}>
                    <Ionicons name="document-text" size={22} color={Colors.accent} />
                  </View>
                ) : (
                  <Image source={{ uri: p.uri }} style={styles.thumbImg} contentFit="cover" />
                )}
                <View style={styles.thumbNo}>
                  <Text style={styles.thumbNoText}>{i + 1}</Text>
                </View>
                <TouchableOpacity
                  style={styles.thumbX}
                  onPress={() => removePage(i)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={`Remove page ${i + 1}`}
                >
                  <Ionicons name="close-circle" size={18} color={Colors.textPrimary} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        {pages.length > 0 ? (
          <TouchableOpacity
            style={[styles.scanBtn, isScanning && styles.scanBtnDisabled]}
            onPress={runScan}
            disabled={isScanning}
            activeOpacity={0.85}
          >
            <Ionicons name="sparkles-outline" size={16} color={Colors.textInverse} />
            <Text style={styles.scanBtnText}>
              {isScanning ? 'Processing…' : `Scan ${pages.length} ${pageLabel}`}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.pdfPill, isScanning && styles.pdfPillDisabled]}
            onPress={pickFromDocuments}
            disabled={isScanning}
            activeOpacity={0.75}
          >
            <Ionicons
              name="document-text-outline"
              size={15}
              color={isScanning ? Colors.textMuted : Colors.accent}
            />
            <Text style={[styles.pdfPillText, isScanning && { color: Colors.textMuted }]}>
              Upload PDF
            </Text>
          </TouchableOpacity>
        )}

        <View style={styles.controls}>
          <TouchableOpacity
            style={styles.sideBtn}
            onPress={pickFromGallery}
            disabled={isScanning}
            accessibilityLabel="Pick from gallery"
          >
            <Ionicons
              name="images-outline"
              size={26}
              color={isScanning ? Colors.textMuted : Colors.textPrimary}
            />
            <Text style={styles.sideBtnLabel}>Gallery</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.captureBtn, isScanning && { borderColor: Colors.textMuted }]}
            onPress={takePicture}
            disabled={isScanning}
            activeOpacity={0.8}
            accessibilityLabel="Capture page"
          >
            <View
              style={[
                styles.captureInner,
                isScanning && { backgroundColor: Colors.textMuted },
              ]}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.sideBtn}
            onPress={() => setFlashMode((f) => (f === 'off' ? 'on' : 'off'))}
            disabled={isScanning}
            accessibilityLabel="Toggle flash"
          >
            <Ionicons
              name={flashMode === 'on' ? 'flash' : 'flash-off-outline'}
              size={26}
              color={
                flashMode === 'on'
                  ? Colors.amber
                  : isScanning
                    ? Colors.textMuted
                    : Colors.textPrimary
              }
            />
            <Text style={styles.sideBtnLabel}>Flash</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 16,
  },
  permTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  permSub: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  permBtn: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 999,
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  permBtnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: Colors.accent,
  },
  permBtnText: { color: Colors.textInverse, fontWeight: '700', fontSize: 15 },

  scanFrame: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  corner: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderColor: Colors.accent,
    borderWidth: 3,
  },
  cornerTL: { top: 4, left: 4, borderRightWidth: 0, borderBottomWidth: 0 },
  cornerTR: { top: 4, right: 4, borderLeftWidth: 0, borderBottomWidth: 0 },
  cornerBL: { bottom: 4, left: 4, borderRightWidth: 0, borderTopWidth: 0 },
  cornerBR: { bottom: 4, right: 4, borderLeftWidth: 0, borderTopWidth: 0 },
  scanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: Colors.accent,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
  },
  processingOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  processingText: { color: Colors.accent, fontSize: 14, fontWeight: '500' },

  bottomControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 14,
    paddingTop: 20,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  hintText: { color: Colors.textSecondary, fontSize: 13, textAlign: 'center' },

  // Captured-page tray
  tray: { maxHeight: 76, alignSelf: 'stretch' },
  trayContent: { gap: 8, paddingHorizontal: 4, alignItems: 'center' },
  thumb: {
    width: 56,
    height: 70,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.accent,
    backgroundColor: Colors.bgCard,
  },
  thumbImg: { width: '100%', height: '100%' },
  thumbPdf: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 229, 201, 0.08)',
  },
  thumbNo: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbNoText: { color: Colors.textPrimary, fontSize: 10, fontWeight: '700' },
  thumbX: {
    position: 'absolute',
    top: 1,
    right: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 9,
  },

  // Scan button (appears when tray has pages)
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'stretch',
    backgroundColor: Colors.accent,
    borderRadius: 999,
    paddingVertical: 13,
  },
  scanBtnDisabled: { opacity: 0.6 },
  scanBtnText: {
    color: Colors.textInverse,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // PDF pill button
  pdfPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 7,
    backgroundColor: 'rgba(0, 229, 201, 0.08)',
  },
  pdfPillDisabled: {
    borderColor: Colors.textMuted,
    backgroundColor: 'transparent',
  },
  pdfPillText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 24,
    marginBottom: 8,
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: Colors.accent,
  },
  sideBtn: { alignItems: 'center', gap: 4, width: 60 },
  sideBtnLabel: { color: Colors.textSecondary, fontSize: 11 },

  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  topBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    color: Colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
  },
});
