# Task 01: Expo + React Native アプリ scaffold

## 目的

仕様書 §2.3 の撮影フローを実装するための土台として、React Native + Expo の最小プロジェクトを `app/` 配下に配置する。以降のタスク (タスク選択 UI、ハンドポーズ検出、カメラ録画、VLM 検証、C2PA 署名、TP 連携など) は、この骨格の上に機能を追加していく。

本タスクの範囲は環境構築のみ。ナビゲーションや画面実装は次タスク以降で行う。

## 仕様書参照

- §1 RootLens の概要 — モバイルアプリで一人称視点の家事動画を撮影
- §1.3 外部依存 — Privy / Solana / Title Protocol (後続タスクで導入)
- §2.1 デバイスは iOS / Android 両対応 (ARKit / MediaPipe は後続)

## 実装内容

### 1. ディレクトリ構成

`../root-lens/app` と同じレイアウトを踏襲する。

```
rootlens-mobile/
├── app/
│   ├── App.tsx
│   ├── index.ts
│   ├── app.json
│   ├── package.json
│   ├── tsconfig.json
│   ├── .gitignore
│   └── assets/        (icon / splash 配置先。本タスクではプレースホルダー)
└── document/
```

### 2. package.json

最小依存のみ。後続タスクで都度追加する。

- `expo` (root-lens と同じ SDK 52 系)
- `expo-status-bar`
- `react`
- `react-native`
- devDeps: `typescript`, `@types/react`, `@babel/core`

### 3. app.json

- `name`: RootLens
- `slug`: rootlens-mobile
- `scheme` / `bundleIdentifier` / `package`: `io.rootlens.app` (root-lens と揃える)
- `version`: 0.0.1
- `newArchEnabled`: true
- `orientation`: portrait
- `userInterfaceStyle`: light
- iOS 用 `infoPlist` の各種 usage description / Android permission は本タスクでは追加しない (該当機能タスクで追加)

### 4. tsconfig.json

`expo/tsconfig.base` を継承し、`strict: true`。

### 5. App.tsx / index.ts

- `App.tsx`: 中央に "RootLens v0.0.1" の最小プレースホルダー UI
- `index.ts`: `registerRootComponent(App)` のみ。Node.js polyfills (shim) は後続タスクで必要になった時点で追加

### 6. .gitignore

- root: `node_modules/`, `.expo/`, `app/ios/Pods/`, `app/android/build/` 等を root-lens から踏襲
- `app/.gitignore`: Expo 標準

## 検証

- `cd app && npm install` が成功する
- `npx expo-doctor` 相当の整合性チェックがパスする
- iOS / Android シミュレータでの実機起動は本タスク外 (Metro が立ち上がる事だけは目標にする)

## 完了条件

- [x] `app/` に Expo TS scaffold が配置されている
- [x] `app/package.json` の expo SDK が 52 系で root-lens と一致 (`expo: ~52.0.49`)
- [x] `npm install` が `app/` で成功 (862 packages)
- [x] root と `app/` に `.gitignore` が配置されている
- [x] `App.tsx` が "RootLens" + "v0.0.1" を表示する最小 UI を持つ
- [x] `npx expo-doctor` が pass する (17/17 checks passed)

## 完了日: 2026-05-06

## ディレクトリ構成 (完了時)

```
rootlens-mobile/
├── .gitignore
├── README.md
├── app/
│   ├── App.tsx
│   ├── index.ts
│   ├── app.json
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── .gitignore
│   └── assets/
└── document/
    └── v0.0.1/
        ├── SPECS_JA.md
        └── tasks/
            └── 01-expo-app-scaffold/
                └── README.md
```
