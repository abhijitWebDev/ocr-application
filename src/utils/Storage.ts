// src/utils/Storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  stripRawText,
  type ExtractedDocument,
  type ExtractionResult,
} from './Schema';

const HISTORY_KEY = '@receipt_scanner_history';
const PENDING_KEY = '@receipt_scanner_pending'; // for passing data between routes

// ── History (array of extracted documents) ────────────────────────────────────
// One scan can yield several documents. We persist each document individually
// (rawText stripped to keep AsyncStorage well under its ~6 MB ceiling).

export async function saveDocuments(
  docs: ExtractedDocument[],
): Promise<boolean> {
  try {
    const existing = await getAllDocuments();
    const lean = docs.map(stripRawText);
    const updated = [...lean, ...existing].slice(0, 100);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    return true;
  } catch {
    return false;
  }
}

export async function getAllDocuments(): Promise<ExtractedDocument[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function deleteDocument(id: string): Promise<boolean> {
  try {
    const all = await getAllDocuments();
    await AsyncStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(all.filter((d) => d.id !== id)),
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearAll(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(HISTORY_KEY);
    return true;
  } catch {
    return false;
  }
}

// ── Settings (save URL + username) ────────────────────────────────────────────
const SETTINGS_KEY = '@receipt_scanner_settings';

export interface AppSettings {
  saveUrl: string;
  username: string;
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { saveUrl: '', username: '' };
  } catch {
    return { saveUrl: '', username: '' };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ── Pending result (used to pass data between expo-router screens) ────────────
// expo-router passes URL params as strings — we stash the full extraction
// result here and read it on the result screen instead of serialising in the URL.

export async function setPendingResult(
  result: ExtractionResult,
): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(result));
}

export async function getPendingResult(): Promise<ExtractionResult | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function clearPendingResult(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_KEY);
}
