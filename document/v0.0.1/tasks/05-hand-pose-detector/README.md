# Task 05: Hand Pose Detector — per-frame landmark を sidecar に埋める

## 目的

仕様書 §2.1 が要求する「両手の 21 関節データ」を **動画フレームと完全同期した time-series** として記録する。Mobile の責務は **生信号を加工せず取り切る** こと。3D 化 / camera pose 推定 / dense action label は server fusion で行う前提。

成果物 (1 セッションあたり):

```
clip_<id>.mp4        # h264 1080p 30fps
clip_<id>.json       # sidecar (task 07 で C2PA 署名対象)
                     # hand_pose.frames[] が mp4 frame index と 1:1 対応
```

これを buyer の server pipeline に投げると、(a) IMU pre-integration から camera 6DoF を VIO で推定し、(b) 2D landmark + monocular/world depth + camera pose で 3D world hand pose に lift し、(c) EgoDex-flavored fused output が再構成可能。

## 仕様書参照

- §2.1 デバイスごとの 21 関節データ (iOS Vision / Android MediaPipe) を verbatim 記録
- §2.6 VLM 検証は範囲外。本タスクは録画中の per-frame landmark に専念
- (新規 schema は本 task 内で確定。task 06/07 で extend)

## 設計思想

1. **Device は raw を取り切る、加工しない**
   - 2D landmark (image-normalized 0..1) + relative z + chirality + confidence をそのまま
   - 3D world pose / camera world pose / IK / 関節 orientation の推定は **全部 server**
2. **mp4 と JSON を frame_index で連結**
   - `video.frames[i].ts_ns` と `hand_pose.frames[i].ts_ns` が同じ monotonic clock で揃う
   - server pipeline はこのインデックス対応で video frame と landmark を結合
3. **sensor-session の camera frame stream を fan-out**
   - ML 用に独立 camera を持たない (root-lens task 02/03 で破綻したパターン)
   - sensor-session を **frame source** として開き、hand pose は consumer

## アーキテクチャ

```
[Camera (sensor-session)]
   AVCaptureVideoDataOutput / Camera2 ImageReader
        │
        ├──→ [VideoEncoder]      → mp4
        ├──→ [Recorder.frame_index recorder]   → video.frames[] (ts_ns per frame)
        └──→ [FrameConsumer] (NEW in task 05)
                │
                └──→ [HandPoseDetector]
                        iOS: VNDetectHumanHandPoseRequest
                        Android: MediaPipe HandLandmarker (ByteBufferImageBuilder)
                            │
                            └──→ [HandPoseRingBuffer] (per frame_index)
                                    │
                                    └──→ stop 時に sidecar の hand_pose.frames[] へ flush
```

## 実装内容

### 1. sensor-session: frame consumer API 追加

#### iOS (`app/modules/sensor-session/ios/sensors/CameraSessionController.swift`)

既存の `AVCaptureVideoDataOutputSampleBufferDelegate` で frame が手元に届くので、ここに 2nd consumer を fan-out する API を追加:

```swift
protocol FrameConsumer: AnyObject {
  func handleFrame(pixelBuffer: CVPixelBuffer, timestampNs: UInt64,
                   orientation: CGImagePropertyOrientation, frameIndex: Int)
}

extension CameraSessionController {
  func attachFrameConsumer(_ consumer: FrameConsumer)
  func detachFrameConsumer(_ consumer: FrameConsumer)
}
```

`captureOutput(_:didOutput:from:)` 内で既存の encoder forward に加えて consumer 配列にも fan-out。

#### Android (`app/modules/sensor-session/android/.../CameraSessionController.kt`)

CameraX を使っていないので Camera2 の `CaptureRequest` に **2nd output として `ImageReader(YUV_420_888)` を追加**。encoder Surface と並列。

```kotlin
interface FrameConsumer {
  fun handleFrame(image: Image, timestampNs: Long, frameIndex: Int)
}

fun attachFrameConsumer(c: FrameConsumer)
fun detachFrameConsumer(c: FrameConsumer)
```

ImageReader の `onImageAvailable` で取れる `Image` を consumer に渡し、消費後 `image.close()` する。

### 2. hand-pose Expo Module 新規

`app/modules/hand-pose/` (旧 broken 実装は削除済み、まっさら)。

#### iOS (`app/modules/hand-pose/ios/`)

```
HandPoseModule.swift           # Expo Module 定義 (start / stop / events)
HandPoseDetector.swift         # VNDetectHumanHandPoseRequest ラッパー (root-lens 旧 task 02 流用可)
HandPoseFrameConsumer.swift    # CameraSessionController.FrameConsumer 実装
```

`SensorSession` に `attachFrameConsumer(self)` し、frame を Vision に流して 21 joint を取り、frame_index を付けて ring buffer に積む。

#### Android (`app/modules/hand-pose/android/`)

```
HandPoseModule.kt
HandPoseDetector.kt           # MediaPipe HandLandmarker (root-lens 旧 task 03 流用可、ByteBufferImageBuilder 経由)
HandPoseFrameConsumer.kt
src/main/assets/hand_landmarker.task   # ~7.8MB MediaPipe model (root-lens から再コピー)
```

YUV_420_888 → ARGB8888 変換 (root-lens の `imageProxyToRotatedArgbBitmap` 移植) → MediaPipe HandLandmarker.detect → 21 joint。

### 3. TS bridge (`app/src/native/handPose.ts`)

```typescript
export type HandLandmark = { x: number; y: number; z: number; confidence: number };
export type HandObservation = {
  handedness: 'left' | 'right' | 'unknown';
  score: number;
  landmarks: HandLandmark[];                  // 21
  world_landmarks: { x_m: number; y_m: number; z_m: number }[] | null;  // Android のみ非 null
};
export type HandPoseFrame = {
  frame_index: number;
  ts_ns: bigint;
  hands: HandObservation[];
};

// stream-bound: sensor-session が start/stop した時に勝手に on/off。
export function getHandPoseFramesForStream(streamId: string): Promise<HandPoseFrame[]>;
```

`getHandPoseFramesForStream` は `nativeStopStream` 後に呼ばれて、sensor-session の `streamId` に対応する hand pose buffer を返す。**JS 側で merging はしない** — server pipeline が `hand_pose.frames` として sidecar に組み込む役を持つ。

### 4. sidecar JSON 整形

mobile が出力する最終形:

```jsonc
{
  "rootlens": {
    "schema_version": "0.0.1",
    "clip_id": "<uuid>",
    "device": { "platform", "model", "os_version", "manufacturer" },
    "capture": { "started_at_unix_ns", "duration_ms", "fps_target": 30, "fps_actual" },
    "task": { "id": null, "name": null, /* task 06 で埋める */
              "start_condition_text": null, "end_condition_text": null,
              "vlm_start": null, "vlm_end": null },
    "video": {
      "path": "file://.../clip.mp4",
      "codec": "h264",
      "resolution": [1920, 1080],
      "intrinsics": [[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
      "frames": [{ "frame_index": 0, "ts_ns": "<bigint string>" }, ...]
    },
    "hand_pose": {
      "schema": "mediapipe-21",
      "frames": [
        { "frame_index": 0, "ts_ns": "...",
          "hands": [
            { "handedness": "left",
              "score": 0.95,
              "landmarks": [{ "x": 0.5, "y": 0.5, "z": 0, "confidence": 0.9 }, /* ×21 */],
              "world_landmarks": [{ "x_m": ..., "y_m": ..., "z_m": ... }, /* ×21 */] // Android only, iOS null
            }
          ] }, ...
      ]
    },
    "imu": {
      "<sensor_id>": {
        "api_path": "android.sensor_event.type_gyroscope_uncalibrated" | "ios.core_motion.device_motion" | ...,
        "samples": [{ "ts_ns": "...", "values": [...] }, ...]
      },
      ...
    },
    "trust": { "c2pa_signed": false }    // task 07 で埋める
  }
}
```

`bigint` は string で encode (JSON overflow 回避)。

整形は **TS 側** で行う:
- `app/src/sensors/sidecar.ts` (新規) に `assembleSidecar(streamResults: NativeSensorResult[], handPoseFrames: HandPoseFrame[]): RootlensSidecar` を実装
- `nativeStopStream` の戻り値 + `getHandPoseFramesForStream` の戻り値を渡してまとめる
- `sensor-session test screen` で生成 → `expo-file-system` で `clip_<id>.json` として保存

### 5. test screen 拡張

`SensorSessionTestScreen.tsx`:

- 録画中: 上部に SVG overlay で 21 joint を描画 (root-lens の `HandPoseOverlay.tsx` を流用、入力型は新しい HandPoseFrame に合わせる)
- stop 後: sidecar JSON のパスと size、frame 数、IMU sensor 数を表示

これで「per-frame landmark が sidecar に入っている」を視覚的に確認可能。task 06 で gesture flow が乗る前段階の動作確認。

## スコープ外 (後続タスク)

- **gesture detection (両手パー / サムズアップ)** → task 06。同じ HandPoseFrame stream を gesture stabilizer (root-lens v0.1.2 sandbox 04 の `gesture.ts`) で消費する別 consumer
- **camera 6DoF world pose 推定 / 3D hand lift** → server fusion pipeline (別リポ、別 milestone)
- **dense action labels** → server (VLM を 1fps 程度で全フレームに当てる)
- **C2PA 署名** → task 07
- **TP / Solana** → task 08

## 検証

- Pixel 10 / Solana Seeker (Android 16) で 5 秒録画
- sidecar の `video.frames.length === hand_pose.frames.length === ~150` (30fps × 5s)
- `hand_pose.frames[i].ts_ns === video.frames[i].ts_ns` (同 monotonic clock)
- `hand_pose.frames[i].hands` が両手映っている時に length=2、片手のみの時 1、写ってない時 0
- 各 hand の landmarks length === 21
- iOS は `world_landmarks: null`, Android は値が入る
- `imu.<sensor_id>.samples` が capture window 全期間ぶん入っている (Pixel 10 で 5s × 200Hz × 7 sensor = ~7000 samples)
- mp4 が QuickTime / Android プレイヤーで再生可能、長さ ≈ 5s

## 完了条件

- [ ] sensor-session に frame consumer API 追加 (iOS + Android)
- [ ] `app/modules/hand-pose/` を新規構築 (iOS Vision / Android MediaPipe)
- [ ] frame_index で video.frames と hand_pose.frames が揃う
- [ ] `app/src/sensors/sidecar.ts` で上記 schema の JSON を assemble
- [ ] test screen に 21-joint overlay 追加
- [ ] sidecar JSON が `clip_<id>.json` としてディスクに書き出される
- [ ] `npx tsc --noEmit` pass
- [ ] `npx expo-doctor` pass
- [ ] Pixel 10 (Android 16) で 5 秒録画 → sidecar の hand_pose.frames が ~150 entry / mp4 frame と 1:1
- [ ] iOS は task 範囲外もしくは simulator のみ確認

## 制限事項

- iOS Vision は 21 joint の 2D のみ (z=0 強制、world_landmarks=null)。これは buyer が知っている前提
- monocular depth / 関節 orientation は mobile では出さない (server fusion 前提)
- gesture state machine は task 06 まで未実装 (test screen は手動 start/stop)
- C2PA 未署名 (task 07 まで)

## 参考: 流用元 (root-lens から)

- `HandPoseDetector.swift` (Vision wrapper) — 過去 task 02 で iOS 動作確認済
- `HandPoseDetector.kt` + `hand_landmarker.task` — 過去 task 03 で MediaPipe 0.10.29 + ByteBufferImageBuilder 経路で Android 16 SIGSEGV を回避済
- `HandPoseOverlay.tsx` (SVG 21-joint 描画) — そのまま流用
- 新規部分: frame consumer API (sensor-session 側拡張)、frame_index 連結、sidecar assembler
