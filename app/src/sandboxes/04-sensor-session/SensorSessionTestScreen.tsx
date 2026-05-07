import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { Camera } from 'expo-camera';
import {
  nativeListAvailableSensors,
  nativeStartStream,
  nativeStopStream,
  type NativeSensorDescriptor,
  type NativeSensorResult,
} from '../../native/sensorSession';
import {
  startHandPose,
  stopHandPose,
  getHandPoseDroppedCount,
  type HandPoseFrame,
} from '../../native/handPose';

// v0.0.1 task 04 sandbox: SensorSession の最小動作確認画面。
//   - 起動時に listAvailableSensors() を叩いて利用可能 sensor を表示
//   - "Start / Stop" で startStream → stopStream を回し、結果を JSON で表示
//   - Preview は SensorSession native module が公開する <SensorPreviewView />
// task 06 (collection flow) でこの画面は廃止し、CaptureView に置き換わる。

const SensorPreviewView = requireNativeViewManager<{ style?: any }>('SensorSession');

type Recording =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; streamId: string; startedAt: number }
  | { kind: 'stopping' };

// IMU sample 配列を含む生 NativeSensorResult をそのまま render に流すと
// JSON.stringify で JS thread が秒単位で block → ANR になる。要約だけ持つ。
type ResultSummary = {
  sensor_id: string;
  api_path: string;
  sample_count: number | null;
  output_path: string | null;
};

export default function SensorSessionTestScreen() {
  const [permission, setPermission] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [sensors, setSensors] = useState<NativeSensorDescriptor[] | null>(null);
  const [recording, setRecording] = useState<Recording>({ kind: 'idle' });
  const [lastResult, setLastResult] = useState<ResultSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Camera permission (Android 必須、iOS は infoPlist で OK)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await Camera.getCameraPermissionsAsync();
        if (cancelled) return;
        if (existing.granted) {
          setPermission('granted');
          return;
        }
        const requested = await Camera.requestCameraPermissionsAsync();
        if (cancelled) return;
        setPermission(requested.granted ? 'granted' : 'denied');
      } catch (e) {
        if (!cancelled) setPermission('denied');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Sensor 一覧
  useEffect(() => {
    if (permission !== 'granted') return;
    let cancelled = false;
    (async () => {
      try {
        const list = await nativeListAvailableSensors();
        if (!cancelled) setSensors(list);
      } catch (e) {
        if (!cancelled) setError(`listAvailableSensors: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [permission]);

  const availableIds = useMemo(
    () => (sensors ?? []).filter(s => s.available).map(s => s.id),
    [sensors],
  );

  const [handPoseStats, setHandPoseStats] = useState<{ frames: number; dropped: number } | null>(null);

  const onStart = useCallback(async () => {
    if (recording.kind !== 'idle') return;
    setRecording({ kind: 'starting' });
    setError(null);
    setHandPoseStats(null);
    try {
      const startNs = BigInt(Date.now()) * 1_000_000n;
      const streamId = await nativeStartStream(availableIds, startNs, 0, '');
      // sensor-session が video モードに入った後で hand pose detector を attach。
      // この順序: 先に analysisReader が capture session に bind されている事が前提。
      try {
        await startHandPose();
      } catch (e) {
        console.warn('[HandPose] start failed (continuing without hand pose):', e);
      }
      setRecording({ kind: 'recording', streamId, startedAt: Date.now() });
    } catch (e) {
      setError(`startStream: ${(e as Error).message}`);
      setRecording({ kind: 'idle' });
    }
  }, [recording, availableIds]);

  const onStop = useCallback(async () => {
    if (recording.kind !== 'recording') return;
    const { streamId } = recording;
    setRecording({ kind: 'stopping' });
    try {
      // hand pose を先に止めて detect を停止 (camera tear-down 中の検出失敗を避ける)
      let handPoseFrames: HandPoseFrame[] = [];
      let dropped = 0;
      try {
        handPoseFrames = await stopHandPose();
        dropped = await getHandPoseDroppedCount();
      } catch (e) {
        console.warn('[HandPose] stop failed:', e);
      }
      const result = await nativeStopStream(streamId);
      console.log('[SensorSession] stop result count=', result.length,
                  'hand_pose frames=', handPoseFrames.length, 'dropped=', dropped);
      const summary: ResultSummary[] = result.map((r) => {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        const samples = payload['samples'];
        return {
          sensor_id: r.sensor_id,
          api_path: r.api_path,
          sample_count: Array.isArray(samples) ? samples.length : null,
          output_path: typeof payload['output_path'] === 'string'
            ? (payload['output_path'] as string)
            : null,
        };
      });
      setLastResult(summary);
      setHandPoseStats({ frames: handPoseFrames.length, dropped });
      setRecording({ kind: 'idle' });
    } catch (e) {
      setError(`stopStream: ${(e as Error).message}`);
      setRecording({ kind: 'idle' });
    }
  }, [recording]);

  const buttonLabel =
    recording.kind === 'idle' ? 'Start recording' :
    recording.kind === 'starting' ? 'Starting…' :
    recording.kind === 'recording' ? 'Stop recording' :
    'Stopping…';

  const buttonDisabled = recording.kind === 'starting' || recording.kind === 'stopping';
  const buttonAction = recording.kind === 'recording' ? onStop : onStart;

  if (permission === 'pending') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#0a1f44" />
        <Text style={styles.centerText}>Checking camera permission…</Text>
      </View>
    );
  }
  if (permission === 'denied') {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Camera permission denied. Open system settings to grant.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.previewContainer}>
        <SensorPreviewView style={StyleSheet.absoluteFill} />
        {recording.kind === 'recording' ? (
          <View style={styles.recBadge}>
            <Text style={styles.recText}>● REC</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.bottom}>
        <Pressable
          style={[styles.button, buttonDisabled && styles.buttonDisabled]}
          onPress={buttonAction}
          disabled={buttonDisabled}
        >
          <Text style={styles.buttonText}>{buttonLabel}</Text>
        </Pressable>

        <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
          <Text style={styles.logCaption}>SENSORS ({availableIds.length}/{sensors?.length ?? 0} available)</Text>
          {(sensors ?? []).map(s => (
            <Text key={s.id} style={[styles.logLine, !s.available && styles.logLineDimmed]}>
              {s.available ? '✓' : '✗'} {s.id}
              {s.unavailable_reason ? `  (${s.unavailable_reason})` : ''}
            </Text>
          ))}
          {error ? (
            <>
              <Text style={[styles.logCaption, styles.logCaptionError]}>ERROR</Text>
              <Text style={styles.logLineError}>{error}</Text>
            </>
          ) : null}
          {handPoseStats ? (
            <>
              <Text style={styles.logCaption}>HAND POSE</Text>
              <Text style={styles.logLine}>
                frames={handPoseStats.frames}  dropped={handPoseStats.dropped}
              </Text>
            </>
          ) : null}
          {lastResult ? (
            <>
              <Text style={styles.logCaption}>LAST RESULT</Text>
              {lastResult.map((r, i) => (
                <Text key={`${r.sensor_id}-${i}`} style={styles.logLine}>
                  {r.sensor_id}
                  {r.sample_count !== null ? `  samples=${r.sample_count}` : ''}
                  {r.output_path ? `  → ${r.output_path}` : ''}
                </Text>
              ))}
            </>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fafaf7' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fafaf7' },
  centerText: { marginTop: 12, color: '#0a1f44', textAlign: 'center' },

  previewContainer: { flex: 1, backgroundColor: '#000', position: 'relative' },
  recBadge: {
    position: 'absolute', top: 16, right: 16,
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: 'rgba(169,78,60,0.9)',
    borderRadius: 4,
  },
  recText: { color: '#fff', fontFamily: 'Menlo', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },

  bottom: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24,
    borderTopWidth: 1, borderTopColor: '#e5e1d8',
    gap: 12,
  },
  button: {
    backgroundColor: '#0a1f44', paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: 4, alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fafaf7', fontWeight: '600', fontSize: 14, letterSpacing: 0.2 },

  log: { maxHeight: 200 },
  logContent: { paddingVertical: 4 },
  logCaption: {
    fontFamily: 'Menlo', fontSize: 10, letterSpacing: 1.4, color: '#5a6b7c',
    fontWeight: '600', marginTop: 8, marginBottom: 2,
  },
  logCaptionError: { color: '#a94e3c' },
  logLine: { fontFamily: 'Menlo', fontSize: 11, color: '#1a2940', lineHeight: 14 },
  logLineDimmed: { color: '#8a96a3' },
  logLineError: { fontFamily: 'Menlo', fontSize: 11, color: '#a94e3c', lineHeight: 14 },
});
