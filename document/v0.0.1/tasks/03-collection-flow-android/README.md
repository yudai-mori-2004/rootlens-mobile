# Task 03: Collection Flow (Android / Solana Seeker)

## 目的

タスク 02 で iOS だけ動く状態の sandbox 04 collection flow を、Solana Seeker (Android 14) でも動くようにする。Seeker は CameraX + MediaPipe が動く通常の Android デバイスとして扱う (Seed Vault / Solana Mobile Stack は wallet 連携の将来タスクで使い、本タスクの範囲外)。

root-lens にも Android Kotlin 実装は存在するが、`HandPoseModule.kt` が View 登録と `paused` prop だけで、iOS にある 3 つの AsyncFunction (`captureSnapshot` / `startRecording` / `stopRecording`) が欠落している。これが「Android 未完」の正体。本タスクで iOS と同等の API surface を Android にも揃え、TS 共通レイヤー (sandbox 04) を無修正で動かせる状態にする。

## 仕様書参照

- §2.1 Android (MediaPipe Hand Landmarker) もデータ収集対象
- §2.3 撮影フロー (両手パー → VLM 開始判定 → 録画 → サムズアップ → VLM 終了判定) を Android で再現

## 既存実装 (root-lens v0.1.2 から取り込み)

| ファイル | 状態 |
|---|---|
| `HandPoseTypes.kt` | そのまま使用 (HandLandmark / HandObservation / HandPoseFrame の schema) |
| `HandPoseDetector.kt` | そのまま使用 (MediaPipe HandLandmarker IMAGE mode + CPU delegate) |
| `HandPosePreviewView.kt` | **拡張**: controller 登録 + 最新 Bitmap 共有 + VideoCapture use case bind + start/stopRecording メソッド |
| `HandPoseModule.kt` | **書き直し**: AsyncFunctions 3 つ追加 |
| `build.gradle` | **拡張**: `camera-video` 依存追加 |
| `AndroidManifest.xml` | そのまま (空。CAMERA は app.json で宣言済み) |
| `assets/hand_landmarker.task` | そのまま (~7MB float16 MediaPipe model) |
| `assets/README.md` | そのまま |

## 新規追加 (iOS 側 `HandPoseCameraController.swift` / `VideoRecorder.swift` の Android 版)

### `HandPoseCameraController.kt`

iOS の `HandPoseCameraController.shared` 相当の `object`。
- 直近フレームの Bitmap を `@Volatile` 保持 (snapshot 用)
- 現在 attach 中の `HandPosePreviewView` を保持 (recording 制御の forward 先)
- `captureSnapshot(context)` — 直近 Bitmap を `cacheDir` に JPEG (quality 0.8) として保存し `file://` URI を返す
- `startRecording(context, outputPath)` / `stopRecording()` — active view へ forward

iOS では singleton が `AVCaptureSession` を所有していたが、Android の CameraX は View が `LifecycleOwner` として bind するため、controller は「state holder + view への forward」に留める (camera を controller 側に持ち上げると lifecycle が複雑化)。

### `VideoRecorder.kt`

iOS の `AVAssetWriter` ラッパーに相当する CameraX `VideoCapture<Recorder>` ラッパー。
- `Recorder` は `QualitySelector` で `Quality.HD` (720p) を指定。fallback は `Quality.SD`
- `prepareRecording(context, FileOutputOptions)` で `Recording` を開始
- `Recording.stop()` 後、`VideoRecordEvent.Finalize` を待って完了 callback (suspend にして TS から `await` 可能に)
- 音声は録らない (iOS の AVAssetWriter 側も video-only。仕様 §2.3 ステップ 4 に音声要件なし)

### `HandPoseModule.kt` の AsyncFunctions

```kotlin
AsyncFunction("captureSnapshot") {
  val ctx = appContext.reactContext ?: throw ...
  HandPoseCameraController.captureSnapshot(ctx)
}
AsyncFunction("startRecording") { outputPath: String ->
  val ctx = appContext.reactContext ?: throw ...
  HandPoseCameraController.startRecording(ctx, outputPath)
}
AsyncFunction("stopRecording") Coroutine { ->
  HandPoseCameraController.stopRecording()
}
```

戻り値は iOS と同形式 (`file://...` URI)。例外メッセージは TS 側 vlmClient / CaptureView の retry / feedback で処理される。

### `HandPosePreviewView.kt` の拡張

- `init` 時に CameraX provider の use case として `Preview + ImageAnalysis + VideoCapture<Recorder>` の 3 つを bind (root-lens では Preview + ImageAnalysis の 2 つだった)
- `onAttachedToWindow` で `HandPoseCameraController.setActiveView(this)`、`onDetachedFromWindow` で `setActiveView(null)`
- `onFrame` の bitmap 生成後、検出と並行して `HandPoseCameraController.updateLatestBitmap(bitmap)` で controller に共有
- `startRecording(context, outputPath): String` / `stopRecording(): String` メソッドを公開 (controller が forward 先として呼ぶ)

## 依存追加 (`app/modules/hand-pose/android/build.gradle`)

```gradle
implementation "androidx.camera:camera-video:1.4.1"
```

CameraX のバージョンは既存定義 `def camerax_version = "1.4.1"` を使う (root-lens と同じ)。

## `expo-module.config.json`

タスク 02 で `["ios"]` のみにしたものを両 platform に戻す:

```json
{
  "platforms": ["ios", "android"],
  "ios": { "modules": ["HandPoseModule"] },
  "android": { "modules": ["io.rootlens.handpose.HandPoseModule"] }
}
```

## 検証

- `npx tsc --noEmit` pass (TS 変更なし)
- `npx expo-doctor` pass (manifest 変更なし)
- Android 実機 (Solana Seeker) ビルド検証 — 本タスクの範囲外。次のステップで以下を実行:
  ```sh
  cd app
  npx expo prebuild --platform android
  npx expo run:android  # Seeker 接続済み前提
  ```
- 期待: アプリ起動 → Home → 04 Collection Flow → fold-laundry 等タスク選択 → 両手パー 1 秒キープ → VLM 開始判定 → 録画 → 両手サムズアップ 1 秒 → VLM 終了判定 → ResultView → mp4 が `file://` で返る

## 完了条件

- [x] root-lens の Android Kotlin 既存ファイル群 (`HandPoseTypes.kt`, `HandPoseDetector.kt`, `AndroidManifest.xml`, `assets/{README.md, hand_landmarker.task}`) が `app/modules/hand-pose/android/` に配置されている
- [x] `HandPoseCameraController.kt` / `VideoRecorder.kt` を新規追加 (iOS 同等の挙動)
- [x] `HandPoseModule.kt` に `captureSnapshot` / `startRecording` / `stopRecording` の 3 AsyncFunction 追加
- [x] `HandPosePreviewView.kt` を controller 連携 + VideoCapture use case bind に拡張
- [x] `build.gradle` に `androidx.camera:camera-video:1.4.1` を追加
- [x] `expo-module.config.json` の `platforms` を `["ios", "android"]` に戻す
- [x] `npx tsc --noEmit` pass (0 errors)
- [x] `npx expo-doctor` pass (17/17 checks)

## 完了日: 2026-05-07

## Path A 採用の根拠 (調査結果)

実装着手前に外部調査した結果、以下を確認:

- **iOS root-lens は `VNDetectHumanHandPoseRequest` (Vision framework) を使用しており、ARKit は使っていない**。Vision の出力は 21 joints の 2D normalized coord のみ (z=0 強制)
- **iPhone には ARKit native hand tracking は無い**。ARKit-grade の 3D hand pose (27 joints / SE(3) world-space) は **Vision Pro 専用** で、Apple EgoDex データセットも全て Vision Pro + visionOS 2 で収集されている
- **Android MediaPipe HandLandmarker は実は iOS Vision の少しスーパーセット** — 2D landmarks に加え relative z + worldLandmarks (3D メートル座標, hand 重心原点) を返せる
- **ARCore に native hand tracking は無い** (Jetpack XR は Android XR ヘッドセット限定)。Solana Seeker のような通常スマホでは MediaPipe 一択

→ Path A: MediaPipe そのまま、iOS 同等 surface (`captureSnapshot` / `start/stopRecording`) を Android に揃え、TS schema は z=0 のまま iOS と完全一致を維持。`worldLandmarks` / ARCore camera pose は仕様 §2.1 のセンサー同梱 (sensor-session 統合) フェーズで導入する。

## 制限事項

- 実機ビルド (`expo prebuild` + `gradlew assembleDebug`) は本タスク範囲外。次の検証ステップで Seeker 実機で行う
- Solana Seeker 固有の Seed Vault / Mobile Wallet Adapter 連携は未着手 (Privy 連携を含む将来タスクで対応)
- IMU / ARCore tracking data 収集は本タスクの範囲外 (仕様 §2.1 のセンサー同梱は v0.0.1 後の統合フェーズ)

## 参考: アーキテクチャ差分メモ

| | iOS | Android |
|---|---|---|
| カメラ session 所有者 | `HandPoseCameraController.shared` (singleton) | `HandPosePreviewView` (LifecycleOwner) |
| frame 取得 | `AVCaptureVideoDataOutput` の delegate | CameraX `ImageAnalysis.Analyzer` |
| 録画 | `AVAssetWriter` で同じ `CMSampleBuffer` を分岐 | CameraX `VideoCapture<Recorder>` を別 use case として bind |
| MediaPipe | Vision framework (Apple) | MediaPipe HandLandmarker (`com.google.mediapipe:tasks-vision`) |
| 共通点 | landmark schema (21 joints, MediaPipe 規約) は完全一致。TS 側は両 platform 同じイベント payload を受ける |
