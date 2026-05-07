package io.rootlens.handpose

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Hand pose ネイティブモジュール (Android / MediaPipe HandLandmarker)。
 *
 * 提供 (iOS HandPoseModule.swift と同 surface):
 *   - View: <HandPosePreviewView /> — CameraX preview + per-frame hand pose detection
 *   - Event: onHandPose
 *   - Prop: paused
 *   - AsyncFunction: captureSnapshot — 直近 frame を JPEG 化して URI 返却 (VLM 判定用)
 *   - AsyncFunction: startRecording / stopRecording — VideoCapture<Recorder> 経由で mp4 録画
 *
 * 設計:
 *   - HandPoseCameraController は singleton state holder。activeView と latestBitmap を保持
 *   - module 関数は controller 経由で view に forward、もしくは latestBitmap を JPEG 化
 */
class HandPoseModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HandPose")

    View(HandPosePreviewView::class) {
      Events("onHandPose")

      Prop("paused") { view: HandPosePreviewView, paused: Boolean ->
        view.setPaused(paused)
      }
    }

    AsyncFunction("captureSnapshot") {
      val ctx = appContext.reactContext
        ?: throw IllegalStateException("RN context unavailable")
      HandPoseCameraController.captureSnapshot(ctx)
    }

    AsyncFunction("startRecording") { outputPath: String ->
      val ctx = appContext.reactContext
        ?: throw IllegalStateException("RN context unavailable")
      HandPoseCameraController.startRecording(ctx, outputPath)
    }

    AsyncFunction("stopRecording") { promise: Promise ->
      HandPoseCameraController.stopRecording { result ->
        result.fold(
          onSuccess = { uri -> promise.resolve(uri) },
          onFailure = { err ->
            promise.reject(
              "HAND_POSE_RECORDING_STOP_ERROR",
              err.message ?: "unknown",
              err,
            )
          },
        )
      }
    }
  }
}
