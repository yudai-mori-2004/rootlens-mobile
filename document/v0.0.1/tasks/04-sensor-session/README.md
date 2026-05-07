# Task 04: SensorSession + Video Recording (raw-signal pipeline)

## 目的

仕様書 §2 を満たす **生センサー信号 + 動画 + JSON sidecar** を出力する Expo Module を構築する。後段 (server) で GTSAM `ImuFactor` による Visual-Inertial Odometry を回せる素材一式が、撮影 1 セッションあたり mp4 + sidecar で揃う状態をゴールとする。

EgoDex のように on-device で 6DoF ハンドポーズを完成させるのではなく、**生信号を verbatim で出して server で fuse する** という設計判断を取る (root-lens v0.1.1 が 4 ヶ月 task 01-04 で確定させたアーキテクチャを踏襲)。理由:

1. ARKit / ARCore は **camera session を排他所有**するため、Vision / MediaPipe との両立が制約を生む
2. 端末側 VIO はブラックボックス (audit 不能)。生 IMU + frame timestamp を残せば後で algorithm を入れ替えられる
3. spoofing 検出 (spec §2 の画面撮影偽装防止) は raw IMU と raw camera frame の整合性検証。ARKit の fused output では足りない

## 仕様書参照

- §2.1 ARKit / ARCore tracking data の同梱 → 本タスクでは生 IMU + frame timestamp + camera intrinsics として保存し、tracking pose は server で計算
- §2.3 撮影フロー (両手パー → 録画 → サムズアップ) → 本タスクでは録画パイプラインのみ。gesture 連動は task 06 で再構築
- §2.7 撮影時の C2PA 署名 → 本タスクの範囲外。生信号と raw mp4 が出れば後続タスクで C2PA を被せられる

## 設計思想 (root-lens v0.1.1 task 02 から継承)

1. **Plan C**: `AVCaptureSession` (iOS) / `Camera2` (Android) を直叩き。`expo-camera` / ARKit / ARCore は使わない
2. **Sensor is the architecture core, camera is one of them**: SensorSession が撮影セッション抽象、Camera は ISensor の 1 実装にすぎない
3. **Don't be the judge**: アプリは OS API 応答を verbatim で記録、解釈・分類しない (`io.rootlens.capture.{platform}.{api_path}` 名前空間で透過保存)
4. **時間窓ベース取得**: `capture(window: TimeWindow)` で全 ISensor を並列同期取得。動画は window 期間中の連続出力、IMU は window 範囲を ring buffer から切り出し

## 移植元 (root-lens から取り込む実装)

- v0.1.1 [task 02 README](/Users/forest/WebCreations/root-lens/document/v0.1.1/tasks/02-sensor-session-and-still-pipeline/README.md) — abstraction 設計
- v0.1.1 [task 03 README](/Users/forest/WebCreations/root-lens/document/v0.1.1/tasks/03-video-pipeline/README.md) — video pipeline 設計 + POSTMORTEM
- `app/modules/sensor-session/` — Swift / Kotlin 実装一式 (約 25 ファイル)
- `app/src/sensors/` — TS abstraction (`ISensor.ts`, `SensorSession.ts`, `types.ts`)
- `app/src/native/sensorSession.ts` — Expo Modules ブリッジラッパー

## 本タスクで実装する範囲

### TS layer (`app/src/sensors/`)

```typescript
type TimeWindow = { startMs: number; durationMs: number };

interface ISensor<TCapability, TResult> {
  readonly id: string;            // e.g. "android.sensor_event.type_gyroscope_uncalibrated"
  capability(): Promise<TCapability | null>;
  capture(window: TimeWindow): Promise<TResult>;
}

interface SensorCaptureResult {
  sensor_id: string;
  api_path: string;               // C2PA assertion label の構成材料 (本タスクでは sidecar JSON key として使用)
  payload: unknown;               // OS API 応答そのまま (JSON-serializable)
  timestamps: { startNs: bigint; endNs: bigint };
}

class SensorSession {
  register(sensor: ISensor): void;
  async capture(window: TimeWindow): Promise<SensorCaptureResult[]>;
  async startStream(window: TimeWindow): Promise<StreamHandle>;  // task 03 由来。動画録画用
  async stopStream(handle: StreamHandle): Promise<StreamResult>;
}
```

### Native: iOS Expo Module (`app/modules/sensor-session/ios/`)

| ファイル | 役割 |
|---|---|
| `SensorSessionModule.swift` | Expo Module 定義 (AsyncFunctions: register / capture / startStream / stopStream) |
| `PreviewView.swift` | AVCaptureVideoPreviewLayer ベースの ExpoView |
| `sensors/CameraSessionController.swift` | AVCaptureSession 所有者 (singleton) |
| `sensors/CameraSensor.swift` | ISensor 実装。`AVCapturePhotoOutput` で静止画 + `AVCaptureMovieFileOutput` または `AVAssetWriter` で動画 |
| `sensors/CoreMotionController.swift` | `CMMotionManager` 起動制御 + sample 配信 |
| `sensors/CoreMotionSensors.swift` | accelerometer / gyro / magnetometer / device-motion / altimeter を **個別の ISensor** として登録 |
| `sensors/SampleRingBuffer.swift` | IMU 用 ring buffer (時間範囲切出し) |

### Native: Android Expo Module (`app/modules/sensor-session/android/.../`)

| ファイル | 役割 |
|---|---|
| `SensorSessionModule.kt` | Expo Module 定義 |
| `PreviewView.kt` | `SurfaceView` ベースの ExpoView (Camera2 と直接結線) |
| `sensors/CameraSessionController.kt` | `CameraManager` + `CameraDevice` + `CameraCaptureSession` 所有者 |
| `sensors/Camera2Sensor.kt` | ISensor 実装。静止画 (`ImageReader`) + 動画 (`VideoEncoder` 経由) |
| `sensors/SensorEventController.kt` | `SensorManager` 起動制御 + listener 配信 |
| `sensors/SensorEventSensor.kt` | 利用可能な `Sensor.TYPE_*` を **個別の ISensor** として登録 |
| `sensors/SensorEventRingBuffer.kt` | IMU 用 ring buffer |
| `sensors/VideoEncoder.kt` | `MediaCodec` + `MediaMuxer` ベースの h264 encoder |
| `stream/StreamSession.kt` | 動画録画 1 回分の状態管理 |
| `stream/StreamRecorder.kt` | encoder ↔ muxer 結線 |
| `stream/StreamRegistry.kt` | 並行 stream 管理 |
| `stream/StreamTypes.kt` | 共通型 |

### 出力形式 (本タスクのゴール)

撮影 1 セッションあたり:

```
clip_<id>.mp4               // h264 / 720p / 30fps
clip_<id>.json              // sidecar
```

sidecar JSON 構造:

```jsonc
{
  "clip_id": "<uuid>",
  "schema_version": "0.0.1",
  "device": {
    "platform": "ios" | "android",
    "model": "iPhone 15 Pro" | "SM-XXXX (Solana Seeker)",
    "os_version": "18.4" | "16",
    "expo_app_version": "0.0.1"
  },
  "camera": {
    "sensor_id": "ios.av_capture.video_data_output" | "android.camera2.video",
    "intrinsics": [[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
    "extrinsics_imu_to_camera": null,    // 後続タスクで calibration result を埋める
    "resolution": [width, height],
    "frame_timestamps_ns": ["<bigint string>", ...]
  },
  "imu": {
    "<sensor_id>": {
      "api_path": "android.sensor_event.type_gyroscope_uncalibrated" | "ios.core_motion.device_motion" | ...,
      "samples": [
        { "ts_ns": "<bigint>", "values": [...] },
        ...
      ]
    },
    ...
  },
  "task": {                                // task 06 で埋める。本タスクでは null 許容
    "id": null,
    "name": null,
    "start_condition": null,
    "end_condition": null
  }
}
```

`bigint` は JSON で string にして overflow 回避 (root-lens 既存方式)。

## スコープ外 (後続タスク)

- **Hand pose detection** → task 05 (sensor-session の frame stream を購読する consumer として実装)
- **Collection flow UX 連動** (gesture / VLM / countdown / result view) → task 06
- **Depth sensor** (`AvCaptureDepthDataSensor.swift` / `Camera2Depth16Sensor.kt`) → task 07 候補
- **C2PA 署名** → task 08 候補。raw mp4 + sidecar の上に被せる
- **Title Protocol / Solana 連携** → 別バージョン (v0.1.0 以降)

## 検証

- iOS / Android 両方で 1 回の `capture` から `clip_*.mp4` + `clip_*.json` が生成される
- mp4 が QuickTime / Android プレイヤーで再生可能
- sidecar JSON で IMU `samples` が capture window 全期間 (e.g. 5 秒なら 100Hz × 5 = 500 サンプル前後) 入っている
- `frame_timestamps_ns` と IMU `ts_ns` が同じ monotonic clock domain (ns 単位で揃う) ことを確認
- root-lens v0.1.1 task 02 の Pixel 10 検証で出していた **21 assertion 相当** の sensor coverage を Solana Seeker でも確認 (POSTMORTEM の Camera2 deadlock / wall-clock vs monotonic ns ミスマッチに注意)

## 完了条件

- [x] `app/modules/sensor-session/` (iOS / Android) を root-lens v0.1.1 から移植
- [x] `app/src/sensors/` (TS abstraction) を root-lens から移植
- [x] `app/src/native/sensorSession.ts` (Expo Modules ブリッジ) を移植
- [x] `npx tsc --noEmit` pass (0 errors)
- [x] `npx expo-doctor` pass (17/17)
- [x] Pixel 10 (Android 16) で recording start → mp4 finalize の end-to-end が通る (`muxer closed: video=50, camm=0, camm_dropped=0`)
- [x] sensor 列挙 15/19 available (ACTIVITY_RECOGNITION 不足の Step Counter 等は除外)
- [x] `NativeSensorResult[]` (camera 動画 path + IMU samples) が JS まで到達
- [x] Recording → Stop の UX 確認 (ANR は出ない)
- [ ] sidecar JSON 整形 (現状 IMU samples は `NativeSensorResult.payload.samples` で raw 状態。task 06 で SPEC §出力形式の構造に整形)
- [ ] iOS 実機検証 (本タスクでは Android のみ verify)

## 制限事項

- 本タスクは raw signal 取得のみ。UI は最小限の試験用 screen で良い (task 06 完了で削除)
- C2PA assertion 注入機能は task 07 (C2PA 署名) で別途追加
- 動画 codec は h264 / 1080p / 30fps 固定 (高画質バリアントは後続)
- 録画中の preview 描画は最低限 (本格 UX は task 06 で本実装)

## 完了日: 2026-05-07 (Android 動作確認まで。iOS / sidecar JSON 整形は後続タスクへ繰越)

## 参考: root-lens 移植のチェックリスト

POSTMORTEM 2 件で報告されている既知の罠:
- Camera2 deadlock (concurrent open with 2nd consumer)
- wall-clock vs monotonic ns timestamp ミスマッチ
- Module 親クラス member 衝突 (Expo Modules Kotlin)
- gradle 重複登録 (sensor-session + 既存 module)
- Plan A1 → Plan A2 の preview 切替判断
- View Manager 命名規約
- JSON serialization (bigint / NaN)
- c2patool nested array 表示バグ (本タスクでは C2PA 不採用なので skip)

これらは移植時に最初から避ける。
