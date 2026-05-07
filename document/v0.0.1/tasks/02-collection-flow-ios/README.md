# Task 02: Collection Flow (iOS) — root-lens sandbox 04 を移植

## 目的

仕様書 §2.3 の撮影フロー (タスク選択 → 両手パーで開始 → VLM 開始判定 → 録画 → 両手サムズアップで終了 → VLM 終了判定) を、`../root-lens/document/v0.1.2/tasks/04-collection-flow` にある実装そのまま rootlens-mobile に移植する。

iOS 側は root-lens で実機検証済みのため、TS 共通部 + iOS ネイティブモジュールをそのまま持ち込み、本リポでビルド/型整合が通るところまでを本タスクの範囲とする。

Android 拡張 (Solana Seeker 向け) は次タスクで対応する (root-lens の Android Kotlin 実装は未完のため、本タスクでは持ち込まない)。

## 仕様書参照

- §2.1 一人称視点 + 両手 in-frame の撮影
- §2.3 撮影フロー (両手パー → VLM 開始判定 → 録画 → サムズアップ → VLM 終了判定)
- §2.5 VLM 呼び出しは 1 クリップあたり 2 回 (開始/終了 frame)

## 移植内容

### 1. 依存追加 (`app/package.json`)

`npx expo install` で SDK 52 互換版を解決:

- `expo-camera` — カメラ権限取得
- `expo-image-manipulator` — VLM 送信前の画像縮小 (480px / quality 0.7)
- `expo-dev-client` — カスタムネイティブモジュール起動用 (Expo Go 不可)
- `react-native-svg` — ハンドポーズ overlay / HUD バッジ描画
- `@expo-google-fonts/fraunces` — display フォント
- `@react-navigation/native`, `@react-navigation/native-stack` — sandbox ハブ用 stack
- `react-native-safe-area-context`, `react-native-screens` — RN Navigation peer deps
- `react-native-gesture-handler`, `react-native-reanimated` — 同上

### 2. `app.json` 更新

- iOS `infoPlist`: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`
- Android `permissions`: `CAMERA`, `RECORD_AUDIO`
- `plugins`: `expo-dev-client`, `expo-camera` (権限文言設定)

### 3. TS レイヤー (root-lens から複製)

```
app/src/
├── App.tsx                                                    # 新規 (Stack Navigator + Fraunces font load)
├── native/
│   └── handPose.ts                                            # 移植
└── sandboxes/
    ├── HomeScreen.tsx                                         # 移植
    ├── registry.ts                                            # 04 のみ登録
    ├── 01-hand-pose-gesture/
    │   ├── HandPoseOverlay.tsx                                # 04 が import
    │   └── gesture.ts                                         # 04 が import
    ├── 02-vlm-task-gate/
    │   └── vlmClient.ts                                       # 04 が import
    └── 04-collection-flow/
        ├── CollectionFlowScreen.tsx
        ├── stateMachine.ts
        ├── tasks.ts
        ├── theme.ts
        └── components/
            ├── TaskListView.tsx
            ├── BriefView.tsx
            ├── CaptureView.tsx
            ├── ResultView.tsx
            ├── CountdownOverlay.tsx
            └── HandStatusBadge.tsx
```

01 / 02 の Screen ファイル (HandPoseScreen, TaskGateScreen) は本タスクでは持ち込まない (sandbox 04 が依存しない)。registry.ts も 04 のみエントリ。

### 4. ネイティブモジュール (iOS のみ)

```
app/modules/hand-pose/
├── expo-module.config.json    # platforms: ["ios"] のみに設定 (Android は次タスク)
└── ios/
    ├── HandPoseModule.swift
    ├── HandPoseTypes.swift
    ├── HandPoseDetector.swift
    ├── HandPosePreviewView.swift
    ├── HandPoseCameraController.swift
    ├── VideoRecorder.swift
    └── hand_pose.podspec
```

依存: AVFoundation, Vision, CoreImage, CoreVideo, ExpoModulesCore (iOS 15.1+)

### 5. アセット

```
app/assets/sandbox-04/tasks/
├── fold-laundry/   { start.jpg, end.jpg }
├── wash-dishes/    { start.jpg, end.jpg }
├── cook-pasta/     { start.jpg, end.jpg }
├── vacuum-floor/   { start.jpg, end.jpg }
└── make-bed/       { start.jpg, end.jpg }
```

合計 ~1.4MB。`tasks.ts` の `require()` でビルド時に解決される。

### 6. `App.tsx` セットアップ

`SafeAreaProvider` + `NavigationContainer` + `createNativeStackNavigator`。`Home` (sandbox 一覧) と `04-collection-flow` の 2 screen 登録。Fraunces fonts を `useFonts` で読み込み中は ActivityIndicator。

`react-native-get-random-values` / `fast-text-encoding` などの crypto polyfill は本タスクの範囲外なので import しない (Privy / Solana 連携が入ったら追加)。

## VLM API キー

`process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY` (default provider = claude) を `app/.env` に置く。本タスクではコミットしないが `.env.example` を残す。

## 検証 (本タスク内)

- `npm install` 成功
- `npx tsc --noEmit` でビルドエラー 0
- `npx expo-doctor` pass

実機での動作確認 (iOS dev client + 撮影 → VLM 判定 → mp4 出力) は本タスクの範囲外。次の commit で `npx expo prebuild --platform ios && npx expo run:ios` で確認する想定。

## 完了条件

- [x] 上記の TS ファイル群すべてが `app/src/` 配下に複製されている
- [x] iOS ネイティブモジュール (Swift) 6 ファイル + podspec + expo-module.config.json が `app/modules/hand-pose/` に配置されている
- [x] `expo-module.config.json` の `platforms` が `["ios"]` のみ
- [x] アセット (5 タスク × 2 画像) が `app/assets/sandbox-04/tasks/` に配置されている
- [x] `app/package.json` に必要依存が追加されている (上記 §1 の 11 パッケージ、`expo install` で SDK 52 互換版に解決)
- [x] `app.json` にカメラ / マイク権限と plugin が追加されている
- [x] `App.tsx` が NavigationContainer + Fraunces 読み込み + sandbox stack を構成
- [x] `npm install` 成功 (920 packages)
- [x] `npx tsc --noEmit` ビルドエラー 0
- [x] `npx expo-doctor` pass (17/17 checks)

## 完了日: 2026-05-07

## 移植時の最小修正

- `HandStatusBadge.tsx`: `<Path>` の `stroke` 属性が 2 回指定されていた (root-lens から持ち込んだそのまま)。JSX の duplicate-attribute は後者が勝つので runtime には影響なし。tsc strict (`TS17001`) で fail するため、不要な最初の `stroke="currentColor"` を削除し、条件式も常に `colors.textOnInk` (handsOk=true ブランチ内なので) に簡約。視覚的出力は不変。

## 制限事項 (本タスク段階)

- iOS 実機での動作確認は本タスクの範囲外 (次のステップで実施)
- Android はコード未配置 (次タスク: Solana Seeker 向け実装)
- VLM API キーはユーザーがローカル `.env` に配置 (リポにコミットしない)
