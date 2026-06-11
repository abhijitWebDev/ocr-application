// app/settings.tsx
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getSettings, saveSettings } from '../utils/Storage';
import { Colors } from '../utils/Theme';

export default function SettingsScreen() {
  const [saveUrl, setSaveUrl] = useState('');
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    getSettings().then((s) => {
      setSaveUrl(s.saveUrl);
      setUsername(s.username);
    });
  }, []);

  const handleSave = async () => {
    if (!saveUrl.trim()) {
      Alert.alert('Missing URL', 'Please enter a save URL.');
      return;
    }
    setSaving(true);
    try {
      await saveSettings({ saveUrl: saveUrl.trim(), username: username.trim() });
      Alert.alert('Saved', 'Settings saved successfully.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>SETTINGS</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Save Endpoint section */}
        <View style={styles.section}>
          <View style={[styles.sectionHeader, { borderLeftColor: Colors.accent }]}>
            <Ionicons name="cloud-upload-outline" size={14} color={Colors.accent} />
            <Text style={[styles.sectionTitle, { color: Colors.accent }]}>
              SAVE ENDPOINT
            </Text>
          </View>
          <View style={styles.sectionBody}>
            <Text style={styles.fieldLabel}>Save URL</Text>
            <TextInput
              style={styles.input}
              value={saveUrl}
              onChangeText={setSaveUrl}
              placeholder="https://your-server.com/api/save"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={styles.fieldHint}>
              The invoice JSON will be POST-ed to this URL as{' '}
              <Text style={styles.mono}>application/json</Text>.
            </Text>

            <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="your-username"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldHint}>
              Sent alongside the invoice as{' '}
              <Text style={styles.mono}>username</Text>.
            </Text>
          </View>
        </View>

        {/* Info section */}
        <View style={styles.section}>
          <View style={[styles.sectionHeader, { borderLeftColor: Colors.info }]}>
            <Ionicons name="information-circle-outline" size={14} color={Colors.info} />
            <Text style={[styles.sectionTitle, { color: Colors.info }]}>
              HOW IT WORKS
            </Text>
          </View>
          <View style={styles.sectionBody}>
            <Text style={styles.infoText}>
              After scanning, tap <Text style={styles.infoBold}>Save to Database</Text> on
              the result screen. The app will POST the extracted invoice JSON to the URL
              above with your username.
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          <Ionicons name="checkmark-circle-outline" size={20} color={Colors.textInverse} />
          <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save Settings'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.bgCard,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: Colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
  },

  scroll: { padding: 12, gap: 12 },

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
  sectionBody: { padding: 14, gap: 6 },

  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  input: {
    backgroundColor: Colors.bgElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: Colors.textPrimary,
  },
  fieldHint: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 4,
    lineHeight: 16,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: Colors.textSecondary,
  },

  infoText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  infoBold: { fontWeight: '700', color: Colors.textPrimary },

  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    paddingVertical: 15,
    borderRadius: 14,
    marginTop: 4,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: Colors.textInverse, fontWeight: '700', fontSize: 16 },
});
