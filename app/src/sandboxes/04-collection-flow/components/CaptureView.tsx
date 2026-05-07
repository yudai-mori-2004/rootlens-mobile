import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import {
  nativeListAvailableSensors,
  nativeStartStream,
  nativeStopStream,
  type NativeSensorDescriptor,
  type NativeSensorResult,
} from '../../../native/sensorSession';
import {
  startHandPose,
  stopHandPose,
  captureHandPoseSnapshot,
  subscribeHandPose,
  type HandPoseFrame,
} from '../../../native/handPose';
import { signMp4, isC2paAvailable } from '../../../native/c2paBridge';
import { DEV_CHAIN_PEM, DEV_DEVICE_KEY_PEM } from '../../../native/devCerts';
import { HandPoseOverlay } from '../../01-hand-pose-gesture/HandPoseOverlay';
import {
  evaluateTaskGate,
  DEFAULT_VLM_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  type VlmResult,
  type VlmProvider,
} from '../../02-vlm-task-gate/vlmClient';
import {
  captureReducer,
  classifyHands,
  initialCaptureSub,
  statusText,
} from '../stateMachine';
import { CountdownOverlay } from './CountdownOverlay';
import { HandStatusBadge } from './HandStatusBadge';
import type { TaskDef } from '../tasks';
import { colors, fonts, hairline, radius, space, type } from '../theme';
import { saveSidecar } from '../../../sensors/sidecar';

// v0.0.1 task 06: capture view rewired to sensor-session + hand-pose modules.
// 旧 sandbox 04 の HandPosePreviewView 経由 (broken) は廃止し、
// sensor-session の analysis frame stream を hand-pose 経由で消費する。

const SensorPreviewView = requireNativeViewManager<{ style?: any }>('SensorSession');

const DEFAULT_PROVIDER: VlmProvider = DEFAULT_VLM_PROVIDER;
const DEFAULT_VLM_MODEL = DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER];
const ENV = process.env as Record<string, string | undefined>;
const API_KEY_BY_PROVIDER: Record<VlmProvider, string> = {
  gemini: ENV.EXPO_PUBLIC_GEMINI_API_KEY ?? '',
  claude: ENV.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? '',
  openai: ENV.EXPO_PUBLIC_OPENAI_API_KEY ?? '',
};

interface Props {
  task: TaskDef;
  onComplete: (result: {
    videoUri: string | null;
    sidecarUri: string | null;
    endSnapshotUri: string | null;
    durationMs: number;
    vlmEnd: VlmResult | null;
    vlmEndError: string | null;
  }) => void;
  onCancel: () => void;
}

export const CaptureView: React.FC<Props> = ({ task, onComplete, onCancel }) => {
  const [state, dispatch] = useReducer(captureReducer, initialCaptureSub);
  const [hands, setHands] = useState<HandPoseFrame['hands']>([]);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  const [vlmStartFeedback, setVlmStartFeedback] = useState<{ reason: string; score: number } | null>(null);

  const streamIdRef = useRef<string | null>(null);
  const recordingStartedRef = useRef(false);
  const recordingStartTsRef = useRef<number | null>(null);
  const vlmStartResultRef = useRef<VlmResult | null>(null);
  const sensorIdsRef = useRef<string[]>([]);

  const prevHandsOkRef = useRef(true);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setPreviewSize({ width, height });
  }, []);

  // ----- Setup: sensor list + hand-pose detector start (camera は既に sensor-session 経由で構成済み) -----
  // mount 時に hand-pose を attach し、camera は recording 開始まで idle。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list: NativeSensorDescriptor[] = await nativeListAvailableSensors();
        if (cancelled) return;
        sensorIdsRef.current = list.filter((s) => s.available).map((s) => s.id);
      } catch (e) {
        console.warn('[CaptureView] listAvailableSensors failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ----- hand-pose live event subscription -----
  // 注意: hand-pose は recording に入るまで attach されない。subscribe は always-on で
  // null-safe (hand-pose が未 attach の間はイベントが来ないだけ)。
  useEffect(() => {
    const sub = subscribeHandPose((frame) => {
      setHands(frame.hands);
      const features = classifyHands(frame.hands);
      dispatch({
        kind: 'frame',
        ts: Date.now(),
        bothPalms: features.bothPalms,
        bothThumbsUp: features.bothThumbsUp,
        anyHandDetected: features.anyHandDetected,
      });
    });
    return () => { sub.remove(); };
  }, []);

  // ----- hand-pose attach: mount で start、unmount で stop & drain -----
  // start で sensor-session の analysis frame consumer に hand-pose detector が attach する。
  // 録画自体は state.kind === 'recording' で別途 nativeStartStream を呼ぶ。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await startHandPose();
      } catch (e) {
        console.warn('[CaptureView] startHandPose failed:', e);
      }
    })();
    return () => {
      // cleanup: stop は recording cleanup と同じ useEffect でまとめて行う (下)
      cancelled;
    };
  }, []);

  // ----- VLM start gate: state machine が vlm_start_checking に入ったら snapshot + VLM 判定 -----
  useEffect(() => {
    if (state.kind !== 'vlm_start_checking') return;
    let cancelled = false;
    (async () => {
      try {
        const snapshotUri = await captureHandPoseSnapshot();
        const result = await evaluateTaskGate({
          provider: DEFAULT_PROVIDER,
          apiKey: API_KEY_BY_PROVIDER[DEFAULT_PROVIDER],
          model: DEFAULT_VLM_MODEL,
          imageUri: snapshotUri,
          taskName: task.name,
          conditionText: task.startCondition,
        });
        if (cancelled) return;
        vlmStartResultRef.current = result;
        if (result.match) {
          setVlmStartFeedback(null);
        } else {
          setVlmStartFeedback({ reason: result.reason, score: result.score });
        }
        dispatch({ kind: 'vlmStartResult', match: result.match, reason: result.reason });
      } catch (err) {
        if (cancelled) return;
        const msg = (err as Error).message;
        setVlmStartFeedback({ reason: `VLM error: ${msg}`, score: 0 });
        dispatch({ kind: 'vlmStartError', message: msg });
      }
    })();
    return () => { cancelled = true; };
  }, [state.kind, task]);

  // ----- 録画開始: countdown → recording 遷移時に sensor-session stream を start -----
  useEffect(() => {
    if (state.kind === 'recording' && !recordingStartedRef.current) {
      recordingStartedRef.current = true;
      recordingStartTsRef.current = Date.now();
      (async () => {
        try {
          const startNs = BigInt(Date.now()) * 1_000_000n;
          const sid = await nativeStartStream(sensorIdsRef.current, startNs, 0, '');
          streamIdRef.current = sid;
        } catch (err) {
          console.warn('[CaptureView] startStream failed', err);
        }
      })();
    }
  }, [state.kind]);

  // ----- finalizing: hand-pose stop + end snapshot + VLM end gate + sensor-session stop + sidecar 保存 -----
  useEffect(() => {
    if (state.kind !== 'finalizing') return;
    let cancelled = false;
    (async () => {
      let videoUri: string | null = null;
      let sidecarUri: string | null = null;
      let endSnapshotUri: string | null = null;
      let vlmEnd: VlmResult | null = null;
      let vlmEndError: string | null = null;

      // 1) 終了 snapshot を取る (まだ hand-pose attach 中なので latest frame が引ける)
      try {
        endSnapshotUri = await captureHandPoseSnapshot();
      } catch (err) {
        console.warn('[CaptureView] end snapshot failed', err);
      }

      // 2) hand-pose を止めて per-frame buffer を取り出す
      let handPoseFrames: HandPoseFrame[] = [];
      try {
        handPoseFrames = await stopHandPose();
      } catch (err) {
        console.warn('[CaptureView] stopHandPose failed', err);
      }

      // 3) sensor-session stream を止めて mp4 finalize + IMU samples 取得
      let streamResult: NativeSensorResult[] = [];
      const sid = streamIdRef.current;
      if (sid) {
        try {
          streamResult = await nativeStopStream(sid);
          // CameraSensor の payload に output_path が入っている
          for (const r of streamResult) {
            const payload = (r.payload ?? {}) as Record<string, unknown>;
            const op = payload['output_path'];
            if (typeof op === 'string' && op.endsWith('.mp4')) {
              videoUri = op;
              break;
            }
          }
        } catch (err) {
          console.warn('[CaptureView] stopStream failed', err);
        }
      }

      // 4) VLM end gate: end snapshot + condition text
      if (endSnapshotUri) {
        try {
          vlmEnd = await evaluateTaskGate({
            provider: DEFAULT_PROVIDER,
            apiKey: API_KEY_BY_PROVIDER[DEFAULT_PROVIDER],
            model: DEFAULT_VLM_MODEL,
            imageUri: endSnapshotUri,
            taskName: task.name,
            conditionText: task.endCondition,
          });
        } catch (err) {
          vlmEndError = (err as Error).message;
        }
      }

      // 5) sidecar JSON を assemble して clip mp4 と同じディレクトリに保存
      if (videoUri) {
        try {
          const r = await saveSidecar({
            videoUri,
            streamResult,
            handPoseFrames,
            task: {
              id: task.id,
              name: task.name,
              start_condition_text: task.startCondition,
              end_condition_text: task.endCondition,
              vlm_start: vlmStartResultRef.current
                ? {
                    match: vlmStartResultRef.current.match,
                    score: vlmStartResultRef.current.score,
                    reason: vlmStartResultRef.current.reason,
                  }
                : null,
              vlm_end: vlmEnd
                ? { match: vlmEnd.match, score: vlmEnd.score, reason: vlmEnd.reason }
                : null,
            },
          });
          sidecarUri = r.sidecarUri;
        } catch (err) {
          console.warn('[CaptureView] sidecar save failed', err);
        }
      }

      // 6) C2PA 署名 (dev cert chain がある場合のみ)
      //    devCerts.ts の値が空 (gen-dev-certs.sh 未実行) なら skip。
      if (videoUri && DEV_CHAIN_PEM && DEV_DEVICE_KEY_PEM && isC2paAvailable()) {
        try {
          const signedUri = videoUri.replace(/\.mp4$/i, '.signed.mp4');
          await signMp4(videoUri, signedUri, DEV_CHAIN_PEM, DEV_DEVICE_KEY_PEM);
          videoUri = signedUri;
          console.log('[CaptureView] C2PA signing OK:', signedUri);
        } catch (err) {
          console.warn('[CaptureView] C2PA signing failed (continuing with unsigned mp4):', err);
        }
      } else if (videoUri && (!DEV_CHAIN_PEM || !DEV_DEVICE_KEY_PEM)) {
        console.log('[CaptureView] C2PA signing skipped (devCerts.ts is empty — run scripts/gen-dev-certs.sh)');
      }

      // Title Protocol 登録は撮影フェーズでは実行しない。
      // 採点後に Result 画面で「Core NFT 発行」CTA を押した時に走る。

      if (cancelled) return;
      const durationMs = recordingStartTsRef.current ? Date.now() - recordingStartTsRef.current : 0;
      onComplete({ videoUri, sidecarUri, endSnapshotUri, durationMs, vlmEnd, vlmEndError });
    })();
    return () => { cancelled = true; };
  }, [state.kind, task, onComplete]);

  // ----- 振動 (両手 frame 喪失時) -----
  useLayoutEffect(() => {
    const isRec = state.kind === 'recording' || state.kind === 'thumbs_up_holding';
    const currentHandsOk = isRec ? state.handsOk : true;
    if (prevHandsOkRef.current && !currentHandsOk) {
      Vibration.vibrate(200);
    }
    prevHandsOkRef.current = currentHandsOk;
  }, [state]);

  // ----- cleanup: 画面 unmount 時 (cancel 等) -----
  useEffect(() => {
    return () => {
      // hand-pose を必ず stop (subscribe は別 useEffect で remove 済み)
      stopHandPose().catch(() => {});
      // 録画中なら sensor-session も停止
      const sid = streamIdRef.current;
      if (sid) {
        nativeStopStream(sid).catch(() => {});
      }
    };
  }, []);

  const showOverlay = state.kind !== 'vlm_start_checking' && state.kind !== 'finalizing';
  const isRecording = state.kind === 'recording' || state.kind === 'thumbs_up_holding';
  const handsOkForBadge = isRecording ? state.handsOk : true;

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <View style={styles.topBarMain}>
          <View style={styles.topBarHeader}>
            <Text style={styles.topBarTask}>{task.name}</Text>
            {isRecording ? <RecPill /> : null}
          </View>
          <Text style={styles.topBarStatus} numberOfLines={2}>
            {statusText(state)}
          </Text>
          {vlmStartFeedback ? (
            <View style={styles.feedbackCard}>
              <Text style={styles.feedbackLabel}>
                START · {String(vlmStartFeedback.score).padStart(2, '0')}/100
              </Text>
              <Text style={styles.feedbackBody} numberOfLines={3}>{vlmStartFeedback.reason}</Text>
            </View>
          ) : null}
        </View>
        {isRecording ? (
          <View style={styles.topBarTrail}>
            <HandStatusBadge handsOk={handsOkForBadge} />
          </View>
        ) : null}
      </View>

      <View style={styles.previewContainer} onLayout={onLayout}>
        <SensorPreviewView style={StyleSheet.absoluteFill} />
        {showOverlay ? (
          <HandPoseOverlay
            hands={hands}
            width={previewSize.width}
            height={previewSize.height}
            minConfidence={0.3}
          />
        ) : null}

        {state.kind === 'countdown' ? <CountdownOverlay startTs={state.startTs} /> : null}

        {state.kind === 'vlm_start_checking' || state.kind === 'finalizing' ? (
          <CheckingOverlay
            label={state.kind === 'vlm_start_checking' ? 'Checking start condition' : 'Checking end condition'}
          />
        ) : null}
      </View>

      <View style={styles.bottomBar}>
        <Pressable style={styles.cancelLink} onPress={onCancel} hitSlop={12}>
          <Text style={styles.cancelText}>← Cancel</Text>
        </Pressable>
        <RecordingTip />
      </View>
    </View>
  );
};

const TIPS = [
  'Keep both hands in frame at all times.',
  'Move at a natural pace — don’t rush.',
  'Avoid harsh backlighting from windows behind you.',
  'Show the surface clearly before reaching in.',
  'Both hands working together makes the best clip.',
];

const RecordingTip: React.FC = () => {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % TIPS.length), 6000);
    return () => clearInterval(id);
  }, []);
  return <Text style={styles.tipText} numberOfLines={1}>{TIPS[idx]}</Text>;
};

const RecPill: React.FC = () => (
  <View style={styles.recPill}>
    <View style={styles.recDot} />
    <Text style={styles.recLabel}>REC</Text>
  </View>
);

const CheckingOverlay: React.FC<{ label: string }> = ({ label }) => (
  <View style={styles.checkingOverlay}>
    <View style={styles.checkingCard}>
      <ActivityIndicator color={colors.bgInk} />
      <Text style={styles.checkingLabel}>{label}</Text>
    </View>
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgWarm },

  topBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.m,
    paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.m,
    backgroundColor: colors.bgWhite, ...hairline('bottom'),
  },
  topBarMain: { flex: 1, gap: space.s },
  topBarHeader: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  topBarTask: { flex: 1, fontFamily: fonts.displayMedium, fontSize: 17, color: colors.textInk, letterSpacing: -0.2 },
  topBarStatus: { ...type.bodyS, color: colors.textMute },
  topBarTrail: { paddingTop: 2 },

  feedbackCard: {
    marginTop: space.s, paddingHorizontal: space.m, paddingVertical: space.s,
    borderRadius: radius.s, backgroundColor: colors.statusErrorSoft,
    borderLeftWidth: 2, borderLeftColor: colors.statusError, gap: 2,
  },
  feedbackLabel: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.4, color: colors.statusError, fontWeight: '600' },
  feedbackBody: { ...type.bodyS, color: colors.textBody },

  previewContainer: { flex: 1, position: 'relative', overflow: 'hidden', backgroundColor: '#000' },

  recPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.s, paddingVertical: 3, borderRadius: radius.pill,
    backgroundColor: colors.bgInk,
  },
  recDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.recDot },
  recLabel: { fontFamily: fonts.mono, fontSize: 9, letterSpacing: 1.4, color: colors.textOnInk, fontWeight: '700' },

  checkingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(10, 31, 68, 0.42)',
  },
  checkingCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.m,
    paddingHorizontal: space.xl, paddingVertical: space.m,
    backgroundColor: colors.bgScrim, borderRadius: radius.s,
  },
  checkingLabel: { fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1.2, color: colors.textInk, textTransform: 'uppercase' },

  bottomBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.l, paddingTop: space.m,
    paddingBottom: Platform.OS === 'ios' ? space.xl : space.m,
    backgroundColor: colors.bgWhite, ...hairline('top'),
  },
  cancelLink: { paddingVertical: space.xs },
  cancelText: { ...type.body, color: colors.textInk, fontWeight: '500' },
  tipText: {
    flex: 1, marginLeft: space.l, textAlign: 'right',
    fontFamily: fonts.body, fontSize: 12, color: colors.textMute, fontStyle: 'italic',
  },
});
