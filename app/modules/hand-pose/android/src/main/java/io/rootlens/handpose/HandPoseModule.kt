package io.rootlens.handpose

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.rootlens.sensorsession.sensors.CameraSessionController

/**
 * Hand pose ネイティブモジュール (Android / sensor-session の analysis frame stream を消費)。
 *
 * Public API:
 *   - start(): MediaPipe HandLandmarker を init し、CameraSessionController に
 *     CameraFrameConsumer として attach する。以後、recording 中の analysis frame に対して
 *     per-frame で 21-joint 検出が走り、内部 ring buffer に蓄積される。
 *   - stop(): consumer を detach、検出器を close、累積 frames を返してリセット。
 *
 * 出力は HandPoseFrame[] (frame_index + ts_ns + hands[])。これを TS 側の sidecar
 * assembler (app/src/sensors/sidecar.ts) が video.frames[] と frame_index で 1:1
 * 対応させて clip_*.json に書き出す (task 06)。
 */
class HandPoseModule : Module() {

  private var detector: HandPoseDetector? = null
  private var consumer: HandPoseFrameConsumer? = null

  override fun definition() = ModuleDefinition {
    Name("HandPose")

    // gesture state machine 用 live event。frame consumer が ML 完了時に発火。
    Events("onHandPose")

    AsyncFunction("start") { promise: Promise ->
      val ctx = appContext.reactContext
        ?: return@AsyncFunction promise.reject("HAND_POSE_NO_CONTEXT", "RN context unavailable", null)
      try {
        if (consumer != null) {
          promise.resolve(null)
          return@AsyncFunction
        }
        val det = HandPoseDetector(ctx)
        val cons = HandPoseFrameConsumer(det).apply {
          onFrameReady = { payload -> this@HandPoseModule.sendEvent("onHandPose", payload) }
        }
        CameraSessionController.get(ctx).attachFrameConsumer(cons)
        detector = det
        consumer = cons
        promise.resolve(null)
      } catch (t: Throwable) {
        promise.reject("HAND_POSE_START_ERROR", t.message ?: "start failed", t)
      }
    }

    AsyncFunction("stop") { promise: Promise ->
      val ctx = appContext.reactContext
        ?: return@AsyncFunction promise.reject("HAND_POSE_NO_CONTEXT", "RN context unavailable", null)
      try {
        val cons = consumer
        if (cons == null) {
          promise.resolve(emptyList<Map<String, Any>>())
          return@AsyncFunction
        }
        CameraSessionController.get(ctx).detachFrameConsumer(cons)
        val drained = cons.drainFrames().map { it.toMap() }
        cons.close()
        detector?.close()
        detector = null
        consumer = null
        promise.resolve(drained)
      } catch (t: Throwable) {
        promise.reject("HAND_POSE_STOP_ERROR", t.message ?: "stop failed", t)
      }
    }

    AsyncFunction("droppedCount") {
      consumer?.dropped ?: 0L
    }

    /**
     * VLM 用 snapshot: 直近 analysis frame を JPEG として書き出し file:// URI を返す。
     * hand-pose の start() で frame consumer が attach されている事が前提。
     */
    AsyncFunction("captureSnapshot") { promise: Promise ->
      val ctx = appContext.reactContext
        ?: return@AsyncFunction promise.reject("HAND_POSE_NO_CONTEXT", "RN context unavailable", null)
      val cons = consumer
        ?: return@AsyncFunction promise.reject("HAND_POSE_NOT_STARTED", "hand-pose not started", null)
      try {
        val uri = cons.snapshotJpeg(ctx)
        promise.resolve(uri)
      } catch (t: Throwable) {
        promise.reject("HAND_POSE_SNAPSHOT_ERROR", t.message ?: "snapshot failed", t)
      }
    }
  }
}
