import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import type { NativeSensorResult } from '../native/sensorSession';
import type { HandPoseFrame } from '../native/handPose';

// Task 06: clip 1 セッションあたりの sidecar JSON を assemble して保存する。
//
// schema は task 05 README で固めたもの (rootlens-v0.0.1)。server fusion pipeline
// が VIO + 3D hand lift を行う前提で raw な per-frame data だけを残す。
// Device 側で加工 (smoothing / interpolation 等) はしない。

export interface SidecarTaskMeta {
  id: string;
  name: string;
  start_condition_text: string;
  end_condition_text: string;
  vlm_start: { match: boolean; score: number; reason: string } | null;
  vlm_end: { match: boolean; score: number; reason: string } | null;
}

export interface SidecarSaveArgs {
  videoUri: string;                       // file://.../rootlens_collection_*.mp4
  streamResult: NativeSensorResult[];     // sensor-session の stop 戻り値
  handPoseFrames: HandPoseFrame[];        // hand-pose の stop 戻り値
  task: SidecarTaskMeta;
}

export interface SidecarSaveResult {
  sidecarUri: string;                     // file://.../<basename>.json
  clipId: string;
  fps: number;
  videoFrames: number;
  handPoseFrames: number;
}

/**
 * `streamResult` から camera と IMU を分離し、task 05 schema に流し込んで JSON 保存。
 * 出力先は mp4 と同じディレクトリ + 同 basename + ".json"。
 */
export async function saveSidecar(args: SidecarSaveArgs): Promise<SidecarSaveResult> {
  const { videoUri, streamResult, handPoseFrames, task } = args;

  const clipId = extractClipId(videoUri);

  // ----- Camera & IMU を payload から分離 -----
  let cameraPayload: Record<string, unknown> | null = null;
  let cameraSensorId: string | null = null;
  const imuMap: Record<string, { api_path: string; samples: unknown[] }> = {};

  for (const r of streamResult) {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const isCamera =
      r.sensor_id.includes('camera2') ||
      r.sensor_id.includes('av_capture') ||
      typeof payload['output_path'] === 'string';
    if (isCamera) {
      cameraPayload = payload;
      cameraSensorId = r.sensor_id;
      continue;
    }
    const samples = payload['samples'];
    if (Array.isArray(samples)) {
      imuMap[r.sensor_id] = {
        api_path: r.api_path,
        samples: samples,
      };
    }
  }

  // ----- video.frames[]: camera payload に frame timestamps があれば使う -----
  const frameTimestamps = extractFrameTimestamps(cameraPayload);
  const videoFramesArr = frameTimestamps.map((ts, i) => ({
    frame_index: i,
    ts_ns: ts,
  }));

  // ----- video metadata -----
  const videoMeta = {
    path: videoUri,
    codec: 'h264',
    resolution: extractResolution(cameraPayload),
    intrinsics: extractIntrinsics(cameraPayload),
    frames: videoFramesArr,
    sensor_id: cameraSensorId,
  };

  // ----- hand_pose -----
  const handPose = {
    schema: 'mediapipe-21',
    frames: handPoseFrames.map((f) => ({
      frame_index: f.frame_index,
      ts_ns: f.ts_ns,
      hands: f.hands,
    })),
  };

  // ----- duration 推定 (mp4 frames 数 / 30fps as fallback) -----
  const fps = 30;
  const durationMs =
    videoFramesArr.length > 0 ? Math.round((videoFramesArr.length / fps) * 1000) : 0;

  // ----- assemble -----
  const sidecar = {
    rootlens: {
      schema_version: '0.0.1',
      clip_id: clipId,
      device: {
        platform: Platform.OS,
        model: Device.modelName ?? null,
        os_version: Device.osVersion ?? null,
        manufacturer: Device.manufacturer ?? null,
      },
      capture: {
        started_at_unix_ns: nowUnixNs(),
        duration_ms: durationMs,
        fps_target: fps,
        fps_actual: null as number | null,
      },
      task: {
        id: task.id,
        name: task.name,
        start_condition_text: task.start_condition_text,
        end_condition_text: task.end_condition_text,
        vlm_start: task.vlm_start,
        vlm_end: task.vlm_end,
      },
      video: videoMeta,
      hand_pose: handPose,
      imu: imuMap,
      trust: { c2pa_signed: false },
    },
  };

  // ----- 出力先: mp4 と同ディレクトリ + 同 basename + .json -----
  const sidecarUri = videoUri.replace(/\.mp4$/i, '.json');
  const sidecarPath = sidecarUri.replace(/^file:\/\//, '');

  await FileSystem.writeAsStringAsync(sidecarUri, JSON.stringify(sidecar), {
    encoding: FileSystem.EncodingType.UTF8,
  });

  return {
    sidecarUri,
    clipId,
    fps,
    videoFrames: videoFramesArr.length,
    handPoseFrames: handPoseFrames.length,
  };
}

// ---------- helpers ----------

function extractClipId(videoUri: string): string {
  // file://.../rootlens_collection_<nanos>.mp4 → "rootlens_collection_<nanos>"
  const base = videoUri.replace(/^.*\//, '').replace(/\.mp4$/i, '');
  return base || `clip_${Date.now()}`;
}

function extractFrameTimestamps(cameraPayload: Record<string, unknown> | null): string[] {
  if (!cameraPayload) return [];
  const frames = cameraPayload['frame_timestamps_ns'];
  if (Array.isArray(frames)) {
    return frames.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function extractResolution(cameraPayload: Record<string, unknown> | null): [number, number] | null {
  if (!cameraPayload) return null;
  const video = cameraPayload['video'] as Record<string, unknown> | undefined;
  if (video && typeof video['width'] === 'number' && typeof video['height'] === 'number') {
    return [video['width'] as number, video['height'] as number];
  }
  return null;
}

function extractIntrinsics(cameraPayload: Record<string, unknown> | null): unknown {
  if (!cameraPayload) return null;
  const intrinsics = cameraPayload['intrinsics'];
  return intrinsics ?? null;
}

function nowUnixNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}
