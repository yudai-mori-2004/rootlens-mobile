package io.rootlens.handpose

import android.content.Context
import android.util.Log
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import java.io.File
import java.util.concurrent.Executor

/**
 * iOS `VideoRecorder.swift` (AVAssetWriter ベース) に相当する Android 版。
 * CameraX `VideoCapture<Recorder>` の active `Recording` を制御する。
 *
 * 設計:
 *   - state machine: idle → recording (start) → idle (Finalize event)
 *   - audio は録らない (iOS 側 AVAssetWriter も video-only 設定)
 *   - sandbox 範囲では失敗時 cleanup は最小限 (production では tmpfile rollback 等が必要)
 */
class VideoRecorder {

  @Volatile private var activeRecording: Recording? = null
  @Volatile private var pendingStopCallback: ((Result<String>) -> Unit)? = null
  @Volatile private var outputUri: String? = null

  /**
   * 録画開始。outputPath 空なら context.cacheDir に生成。
   * 返値は出力 mp4 の file:// URI (encoding 完了は stop 時の Finalize で判定)。
   */
  fun startRecording(
    context: Context,
    videoCapture: VideoCapture<Recorder>,
    outputPath: String,
    callbackExecutor: Executor,
  ): String {
    check(activeRecording == null) { "already recording" }

    val outputFile: File = if (outputPath.isEmpty()) {
      File(context.cacheDir, "rootlens_collection_${System.nanoTime()}.mp4")
    } else {
      File(outputPath.removePrefix("file://"))
    }
    outputFile.parentFile?.mkdirs()
    if (outputFile.exists()) outputFile.delete()

    val uri = "file://${outputFile.absolutePath}"
    outputUri = uri

    val outputOptions = FileOutputOptions.Builder(outputFile).build()

    activeRecording = videoCapture.output
      .prepareRecording(context, outputOptions)
      .start(callbackExecutor) { event ->
        if (event is VideoRecordEvent.Finalize) {
          val cb = pendingStopCallback
          pendingStopCallback = null
          activeRecording = null

          if (event.hasError()) {
            Log.e(TAG, "recording finalize error code=${event.error}", event.cause)
            cb?.invoke(
              Result.failure(
                RuntimeException(
                  "recording error code=${event.error}: " +
                    (event.cause?.message ?: "unknown")
                )
              )
            )
          } else {
            cb?.invoke(Result.success(uri))
          }
        }
      }

    return uri
  }

  /**
   * 録画停止。Finalize 完了時に callback。
   * 録画中でなければ即 IllegalStateException で reject。
   */
  fun stopRecording(callback: (Result<String>) -> Unit) {
    val recording = activeRecording
    if (recording == null) {
      callback(Result.failure(IllegalStateException("not recording")))
      return
    }
    if (pendingStopCallback != null) {
      callback(Result.failure(IllegalStateException("stop already in progress")))
      return
    }
    pendingStopCallback = callback
    recording.stop()
  }

  /**
   * View detach 等の cleanup 用。callback 無しで stop し、Finalize 結果は捨てる。
   */
  fun stopRecordingSilent() {
    val recording = activeRecording ?: return
    pendingStopCallback = null
    try {
      recording.stop()
    } catch (t: Throwable) {
      Log.w(TAG, "silent stop failed", t)
    }
  }

  companion object {
    private const val TAG = "HandPoseVideoRecorder"
  }
}
