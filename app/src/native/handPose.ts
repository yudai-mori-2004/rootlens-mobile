import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

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

interface HandPoseNativeModule {
  start(): Promise<null>;
  stop(): Promise<HandPoseFrame[]>;
  droppedCount(): Promise<number>;
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
