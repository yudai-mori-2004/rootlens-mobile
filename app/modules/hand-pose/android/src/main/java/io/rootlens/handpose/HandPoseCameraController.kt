package io.rootlens.handpose

import android.content.Context
import android.graphics.Bitmap
import java.io.File
import java.io.FileOutputStream

/**
 * iOS の `HandPoseCameraController.shared` (singleton) に対応する Android 版 state holder。
 *
 * 設計差分:
 *   - iOS は AVCaptureSession を controller が所有 (view は consumer として attach)
 *   - Android の CameraX は View が LifecycleOwner として bind するため、camera 自体は
 *     `HandPosePreviewView` が所有する。controller は「直近 Bitmap の保持」と「現在 mount
 *     中の view への forward」だけを担う薄い state holder
 *   - JS-side からは iOS と完全に同じ AsyncFunction surface (captureSnapshot / startRecording
 *     / stopRecording) を提供する
 *
 * Thread 安全性:
 *   - latestBitmap は @Volatile (analysis thread 書き込み / module thread 読み)
 *   - activeView も @Volatile (main thread が attach/detach)
 *   - bitmap オブジェクト自体は不変 (recycle しない) ので concurrent read は安全
 */
object HandPoseCameraController {

  @Volatile private var activeView: HandPosePreviewView? = null
  @Volatile private var latestBitmap: Bitmap? = null

  fun setActiveView(view: HandPosePreviewView?) {
    activeView = view
  }

  fun updateLatestBitmap(bitmap: Bitmap) {
    latestBitmap = bitmap
  }

  fun clearLatestBitmap() {
    latestBitmap = null
  }

  /**
   * 直近 frame を JPEG として cache directory に書き出し file:// URI を返す。
   * frame が無ければ throw。VLM 開始/終了判定で使う。
   */
  fun captureSnapshot(context: Context, quality: Int = 80): String {
    val bitmap = latestBitmap
      ?: throw IllegalStateException("no frame available yet")
    val file = File(
      context.cacheDir,
      "hand_pose_snapshot_${System.nanoTime()}.jpg"
    )
    FileOutputStream(file).use { out ->
      bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
    }
    return "file://${file.absolutePath}"
  }

  /**
   * 録画開始。outputPath 空なら cacheDir に生成。返値は出力 mp4 の file:// URI。
   * mount 中の HandPosePreviewView が必要。
   */
  fun startRecording(context: Context, outputPath: String): String {
    val view = activeView
      ?: throw IllegalStateException("no active HandPosePreviewView")
    return view.startRecordingFromController(context, outputPath)
  }

  /**
   * 録画停止。VideoRecordEvent.Finalize 完了で callback (success URI / failure)。
   */
  fun stopRecording(callback: (Result<String>) -> Unit) {
    val view = activeView
    if (view == null) {
      callback(Result.failure(IllegalStateException("no active HandPosePreviewView")))
      return
    }
    view.stopRecordingFromController(callback)
  }
}
