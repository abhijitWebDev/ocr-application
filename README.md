# OCR Invoice & Document Scanner 📄

A React Native / Expo app that scans invoices, delivery challans, e-Way bills, and bank/vendor payment advices, then extracts them into structured JSON using **Gemini Vision**. Built for Indian commercial documents (GST, HSN, e-Way bill, TDS) but works with receipts and bills from any region.

The app runs entirely on-device — there is no backend. OCR is performed by calling Gemini directly; scans are stored locally in AsyncStorage. An optional user-configured "Save URL" can POST results to your own server.

## Features

- **Camera / Gallery / PDF capture** — scan with the camera, pick existing images, or upload PDFs (multi-page supported).
- **Multi-page & multi-document scans** — capture several pages into one job. Gemini segments them into logical documents in a single pass:
  - a table that continues across pages → **one** document,
  - a tax invoice + its e-Way bill / challan → **one merged** document (vehicle / LR / transporter pulled from the e-Way bill),
  - unrelated documents → **separate** records.
- **Structured extraction** — Gemini returns a typed `{ documents: [...] }` envelope via JSON schema (structured output), so there's no fragile text parsing.
- **Two document shapes** (discriminated by `docType`):
  - **Goods** (`TAX_INVOICE` / `DELIVERY_CHALLAN` / `EWAY_BILL`) — supplier, GSTIN, invoice/challan no & date, header PO no, e-Way/vehicle/LR/transporter, line items (description, qty + **unit**, rate, **amount**, batch), taxable value, tax, invoice total.
  - **Payment advice** (`PAYMENT_ADVICE`) — payer, UTR/reference, date, grand total, and a table of settled invoice references (PO / Doc / GRN, invoice amount, TDS/deduction, net paid).
- **History** — every extracted document is stored locally (up to 100), searchable by name or reference, with type badges and totals.
- **Share & Save** — share a text summary, or POST the full `{ documents, username }` payload to your configured endpoint.
- **Graceful fallback** — if the Gemini call fails, the app falls back to Google Vision raw-text OCR + a regex parser, one document per input.

## Tech stack

- Expo SDK 55, Expo Router (file-based routing), React Native 0.83, React 19
- Gemini 2.5 Flash (vision + structured output) for extraction
- Google Cloud Vision (fallback raw-text OCR)
- AsyncStorage for local persistence
- `expo-camera`, `expo-image-picker`, `expo-document-picker`, `expo-image`, `expo-haptics`

## Project structure

```
src/
  app/                 # screens (expo-router)
    index.tsx          # scanner — camera/gallery/PDF capture + page tray
    result.tsx         # docType-aware result view + document selector
    history.tsx        # local scan history
    settings.tsx       # Save URL + username
    _layout.tsx        # navigation stack
  utils/
    Schema.ts          # document envelope types + helpers (source of truth)
    Ocrservice.ts      # Gemini structured extraction + Vision fallback
    Storage.ts         # AsyncStorage: history + pending result + settings
    Invoiceparser.ts   # legacy regex parser (used by the fallback path)
    Theme.ts           # colors + docType label/color maps
```

## Get started

### 1. Prerequisites

- Node.js 18+
- A **Gemini API key** ([Google AI Studio](https://aistudio.google.com/app/apikey)).
- Optionally, a **Google Cloud Vision API key** for the fallback path.
- For camera scanning you need a **development build** (the camera does not run in Expo Go). PDF upload and gallery import work in Expo Go.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

Create a `.env` file in the project root:

```bash
EXPO_PUBLIC_GEMINI_KEY=your_gemini_api_key
EXPO_PUBLIC_VISION_KEY=your_google_vision_api_key   # optional, enables fallback
```

> ⚠️ **Security note:** `EXPO_PUBLIC_*` variables are embedded in the app bundle and are extractable from a shipped build. For production, proxy the Gemini/Vision calls through a backend so the keys stay server-side.

### 4. Run the app

```bash
npx expo start          # dev server
npm run android         # build & run on Android
npm run ios             # build & run on iOS
```

If Metro serves a stale manifest (e.g. an "Asset not found" log), clear the cache:

```bash
npx expo start -c
```

## How to use

1. **Capture** — take photos, pick images, or upload PDFs. Each is added to the page tray.
2. **Scan** — tap **Scan N pages** to send everything to Gemini in one pass.
3. **Review** — the result screen shows each extracted document; switch between them with the selector when a scan yields more than one.
4. **Save / Share** — share a summary, or save to your endpoint (set it in **Settings** first).

## Output shape

```jsonc
{
  "documents": [
    {
      "docType": "TAX_INVOICE",
      "supplier": "Arihant Gold Plast Pvt Ltd",
      "supplierGSTNo": "26AAJCS6082N1ZO",
      "invoiceNo": "SAT/2526/001642",
      "invoiceDate": "06/03/2026",
      "challanNo": null,
      "poNo": "USK/25-26/1474",
      "eWayBillNo": "612071250314",
      "vehicleNo": "DD01-A-9334",
      "transporter": null,
      "items": [
        { "itemDesc": "Polypropylene Sheets & Rolls", "qty": 2514.40,
          "unit": "KG", "rate": 134.24, "amount": 337533.00, "batchNo": null }
      ],
      "taxableValue": 337533.00,
      "taxAmount": 60756.00,
      "invoiceTotal": 398289.00
    }
  ]
}
```

Payment-advice documents instead carry a `paymentAdvice` object (`payer`, `paymentRef`, `paymentDate`, `grandTotal`, `references[]`). See `src/utils/Schema.ts` for the full type definitions.

## Quality checks

```bash
npx tsc --noEmit        # typecheck
npm run lint            # ESLint (expo config)
```
