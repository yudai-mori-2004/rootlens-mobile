# Task 06: Collection Flow on top of sensor-session

## 目的

仕様書 §2.3 の撮影フローを **sensor-session + hand-pose の上に** 再構築する:

```
タスク選択 → brief → capture (両手パー → VLM 開始判定 → countdown → 録画 → サムズアップ → VLM 終了判定) → result
```

このタスク完了で、 buyer が server fusion に投げるための **完全な per-clip 出力** が生成される:

```
clip_<id>.mp4     # h264 1080p 30fps
clip_<id>.json    # task 05 schema (rootlens.task / video.frames / hand_pose.frames / imu / device)
```

## 仕様書参照

- §2.3 撮影フロー (両手パー / VLM 開始 / countdown / 録画 / サムズアップ / VLM 終了)
- §2.5 VLM 呼び出しは clip 単位 2 回 (start, end frame)
- §2.6 VLM は frame 1 枚だけ。撮影中の品質判定は server side
- §2.7 C2PA 署名 (本タスク範囲外、task 07)

## 設計

### TS layer 復活 + sensor-session に bind し直し

root-lens v0.1.2 sandbox 04 の TS UI を **再導入**するが、camera/録画/hand-pose は以下の 2 module 経由:

```
sandbox 04 UI (CaptureView / CountdownOverlay / TaskListView ...)
        │
        ├──→ sensor-session.startStream / stopStream         (record + IMU buffer)
        ├──→ hand-pose.start / stop                          (per-frame 21-joint buffer)
        ├──→ vlmClient.evaluateTaskGate                      (start/end snapshot 1 枚ずつ)
        └──→ snapshot via sensor-session capture(window=0)   (VLM 用 JPEG snapshot)
```

旧 sandbox 04 が独自 camera を持っていた箇所 (`HandPosePreviewView`, `captureHandPoseSnapshot`, `startHandPoseRecording`) を **全部 sensor-session 由来に置換**。

### 復元するファイル (root-lens v0.1.2 から再コピー、import 先だけ書き換え)

```
app/src/sandboxes/04-collection-flow/
├── CollectionFlowScreen.tsx     # mode 切替 (task_list → brief → capture → result)
├── stateMachine.ts              # capture flow reducer (await_palm → countdown → recording → ...)
├── tasks.ts                     # 5 task カタログ (洗濯畳み / 皿洗い / パスタ / 掃除機 / ベッドメイキング)
├── theme.ts                     # design tokens
└── components/
    ├── TaskListView.tsx
    ├── BriefView.tsx
    ├── CaptureView.tsx          # ← 中身を sensor-session 経由に書き換え
    ├── ResultView.tsx
    ├── CountdownOverlay.tsx
    └── HandStatusBadge.tsx

app/src/sandboxes/01-hand-pose-gesture/
├── HandPoseOverlay.tsx          # SVG 21-joint 描画 (HandPoseFrame を入力に書き換え)
└── gesture.ts                   # detectGesture / GestureStabilizer (root-lens から流用、import path 修正)

app/src/sandboxes/02-vlm-task-gate/
└── vlmClient.ts                 # Claude / Gemini / OpenAI provider 抽象 (root-lens から流用そのまま)
```

### 変更点

CaptureView の差し替えポイント:

| 旧 (broken) | 新 |
|---|---|
| `<HandPosePreviewView onHandPose={…} />` | `<SensorPreviewView />` + `useEffect` で `startHandPose / stopHandPose` を駆動、結果を frame stream として購読 |
| `captureHandPoseSnapshot()` | sensor-session の `nativeCapture(['camera-jpeg'], windowStart, 0, 0)` で 1 frame JPEG 取得 |
| `startHandPoseRecording / stopHandPoseRecording` | sensor-session の `nativeStartStream / nativeStopStream` |
| onHandPose event (per frame, push) | hand-pose buffer を 100ms interval poll もしくは subscribe API (要追加: hand-pose に live-event API) |

ここで 1 つ判断ポイント: gesture 判定は **per-frame ライブイベント** が要るので、hand-pose Module に **subscribe (event emitter)** を追加するか、**JS 側で 100ms 毎に最新 frame を pull** するか。

- **Option A (event emit)**: 30fps push、UX 即応。Kotlin で `sendEvent` 実装が必要 (Expo Modules `EventEmitter`)
- **Option B (poll)**: API 追加なしで済む (`getLatestHandPoseFrame()` を 100ms timer で叩く)。UX は最大 100ms 遅延

→ **Option A 推奨** (gesture countdown UX に 100ms 遅延は感じる)。Kotlin の `sendEvent("onHandPose", ...)` 実装で 30fps push にする。

### sidecar JSON assembly

`stop` 後に JS 側で:

```typescript
// app/src/sensors/sidecar.ts (新規)
async function assembleAndSaveSidecar(args: {
  streamResult: NativeSensorResult[];   // sensor-session
  handPoseFrames: HandPoseFrame[];      // hand-pose
  task: TaskMeta;                        // task.id, name, conditions, vlm_start, vlm_end
  videoPath: string;                     // file://
}): Promise<{ jsonPath: string }> {
  // 1. NativeSensorResult から camera intrinsics / IMU samples を抽出して整形
  // 2. handPoseFrames を hand_pose.frames[] として JSON.stringify
  // 3. expo-file-system で clip_<uuid>.json として videoPath と同じディレクトリに書く
  // 4. jsonPath を返す
}
```

書き出し先は `expo-file-system` の `documentDirectory + "rootlens/clips/"`。mp4 と JSON は同じ basename。

## 実装順序

1. **hand-pose に live event を追加** (Kotlin: `EventEmitter.sendEvent("onHandPose", ...)`、TS: `addListener`)
2. **TS sandbox 04 ファイル群を root-lens から再コピー** (TaskListView / BriefView / CaptureView / ResultView / CountdownOverlay / HandStatusBadge / theme / tasks / stateMachine)
3. **gesture.ts / HandPoseOverlay.tsx / vlmClient.ts も再コピー**
4. **CaptureView 書き換え**: `<HandPosePreviewView>` → `<SensorPreviewView>`、 `captureHandPoseSnapshot` → sensor-session capture API、recording start/stop → sensor-session stream API、onHandPose subscribe → hand-pose event emitter
5. **app/src/sensors/sidecar.ts** 新規 (JSON assemble + 書き出し)
6. **registry.ts**: `04-sensor-session` を `04-collection-flow` に置き換え
7. **app/assets/sandbox-04/** illustration 画像を root-lens から再コピー (5 task × 2)
8. **VLM API key** を `.env` から読む (EXPO_PUBLIC_ANTHROPIC_API_KEY)
9. Pixel 10 で実機検証

## 検証

- 04 Collection Flow → 5 task 一覧 → 1 つ選択 → brief 表示 → Begin
- 両手パーで 1 秒キープ → "Checking start condition…" → VLM 判定 → countdown 3,2,1 → 録画開始
- 録画中: 21-joint overlay + REC pill 表示
- 両手サムズアップ 1 秒キープ → "Checking end condition…" → VLM 判定 → ResultView 表示
- ResultView: snapshot サムネ + score (VLM 終了判定) + duration
- ファイルシステム: `rootlens/clips/<uuid>.mp4` + `<uuid>.json` が出力されている
- JSON の中身: `task.id == "fold-laundry"`, `task.vlm_start.match == true`, `hand_pose.frames.length ≈ video.frames.length`, `imu.<sensor_id>.samples.length` 妥当

## 完了条件

- [x] hand-pose に live event API 追加 (Kotlin sendEvent + TS addListener)
- [x] TS sandbox 04 ファイル群を root-lens から再コピー (TaskListView / BriefView / CaptureView / ResultView / CountdownOverlay / HandStatusBadge / theme / tasks / stateMachine)
- [x] gesture.ts / HandPoseOverlay.tsx / vlmClient.ts 再コピー
- [x] CaptureView を sensor-session + hand-pose 経由に書き換え
- [x] sidecar.ts (新規) で clip_<uuid>.{mp4,json} を expo-file-system に書く
- [x] registry を 04-collection-flow に切替
- [x] アセット (5 task × 2 画像) を再コピー
- [x] `tsc --noEmit` pass
- [x] `expo-doctor` pass
- [x] Pixel 10 で end-to-end (task 選択 → 撮影 → VLM 判定 → result → JSON 確認)
- [x] 広角 (Pixel 10 ultra-wide 1.854mm) 自動選択
- [x] hand-pose GPU delegate (Adreno) でパフォ向上
- [x] resume-from-home フリーズ修正 (preview surface destroy 時に device tear-down)

## 完了日: 2026-05-07

## スコープ外 (後続タスク)

- **C2PA 署名** → task 07 (mp4 + JSON を一括 sign)
- **TP / Solana 連携** → task 08
- **iOS 実機検証** (本タスクは Android のみ)
- **Privacy 後処理** (face blur / OCR blur) → 仕様 §2.3 step 7 だが server side 実装の想定

## 参考: root-lens 流用箇所

- TS UI 一式: `../root-lens/app/src/sandboxes/04-collection-flow/`
- gesture: `../root-lens/app/src/sandboxes/01-hand-pose-gesture/gesture.ts`
- VLM: `../root-lens/app/src/sandboxes/02-vlm-task-gate/vlmClient.ts`
- assets: `../root-lens/app/assets/sandbox-04/tasks/`
