import { Platform } from 'react-native';
import { EventEmitter, requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

// hand-pose ネイティブモジュールの薄ラッパー (Task 05)。
// sensor-session の analysis frame stream に detector を attach/detach するだけで、
// 自身は camera を持たない (root-lens task 02/03 の "2 camera owners" 失敗を踏まえ)。

export type HandLandmark = {
  x: number;
  y: number;
  z: number;
  confidence: number;
};

export type HandWorldLandmark = {
  x_m: number;
  y_m: number;
  z_m: number;
};

export type HandObservation = {
  handedness: 'left' | 'right' | 'unknown';
  score: number;
  landmarks: HandLandmark[];                  // 必ず 21
  world_landmarks: HandWorldLandmark[] | null; // Android のみ非 null (iOS Vision は null)
};

export type HandPoseFrame = {
  frame_index: number;
  ts_ns: string;       // bigint string
  hands: HandObservation[];
};

/** MediaPipe / Apple Vision 共通の 21-joint index 規約 */
export const HAND_LANDMARK_INDICES = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const;

/** SVG overlay 描画用の bone connections */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

interface HandPoseNativeModule {
  start(): Promise<null>;
  stop(): Promise<HandPoseFrame[]>;
  droppedCount(): Promise<number>;
  captureSnapshot(): Promise<string>;
}

const nativeImpl = requireOptionalNativeModule<HandPoseNativeModule>('HandPose');

export function isHandPoseAvailable(): boolean {
  return nativeImpl !== null;
}

export async function startHandPose(): Promise<void> {
  if (!nativeImpl) {
    if (Platform.OS === 'ios') {
      // iOS implementation deferred (task 05 は Android only)
      return;
    }
    throw new Error('HandPose native module unavailable');
  }
  await nativeImpl.start();
}

export async function stopHandPose(): Promise<HandPoseFrame[]> {
  if (!nativeImpl) return [];
  return nativeImpl.stop();
}

export async function getHandPoseDroppedCount(): Promise<number> {
  if (!nativeImpl) return 0;
  return nativeImpl.droppedCount();
}

/**
 * VLM 用 snapshot: 直近 analysis frame を JPEG として書き出し file:// URI を返す。
 * `startHandPose()` 後 `stopHandPose()` 前のみ有効。
 */
export async function captureHandPoseSnapshot(): Promise<string> {
  if (!nativeImpl) throw new Error('HandPose native module unavailable');
  return nativeImpl.captureSnapshot();
}

// ----------------- Live event subscription (Task 06) -----------------

const emitter: InstanceType<typeof EventEmitter> | null = nativeImpl
  ? new EventEmitter(nativeImpl as any)
  : null;

/**
 * Per-frame の HandPoseFrame を受け取る subscription。gesture state machine が
 * use する。ML 推論が完了する度 (Pixel 10 で 30 Hz 程度) に発火。
 * `start()` 後 `stop()` 前のみイベントが流れる。
 */
export function subscribeHandPose(
  listener: (frame: HandPoseFrame) => void
): EventSubscription {
  if (!emitter) {
    return { remove: () => {} };
  }
  return emitter.addListener('onHandPose', listener);
}
