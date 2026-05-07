package io.rootlens.handpose

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import io.rootlens.sensorsession.sensors.CameraFrameConsumer
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * sensor-session の analysis stream を購読し、毎フレーム MediaPipe HandLandmarker
 * に通して per-frame の [HandPoseFrame] を ring buffer に蓄積する。
 *
 * onFrame は CameraSessionController の `rootlens-camera-analysis` thread で同期呼出。
 * その場で YUV planes を NV21 ByteArray に詰めて Image.close() を返し、ML 推論は
 * 別 HandlerThread (`rootlens-hand-pose`) に逃がす。
 *
 * dropped frames は `dropped` counter でカウントされる (前フレーム ML が完了する前に
 * 新フレームが来た場合)。30fps × 720p で MediaPipe CPU delegate ~10-20ms 程度なので
 * Pixel 10 では原則 drop しない見込み。
 */
class HandPoseFrameConsumer(
  private val detector: HandPoseDetector
) : CameraFrameConsumer {

  companion object { private const val TAG = "HandPoseFrameConsumer" }

  private val mlThread = HandlerThread("rootlens-hand-pose").apply { start() }
  private val mlHandler = Handler(mlThread.looper)
  private val processing = AtomicBoolean(false)

  private val frames = mutableListOf<HandPoseFrame>()
  private val framesLock = Any()

  @Volatile var dropped: Long = 0L
    private set

  override fun onFrame(image: Image, timestampNs: Long, frameIndex: Long, sensorOrientation: Int) {
    // 前フレームの ML が走っていれば drop。リアルタイム性 > 完全性。
    if (!processing.compareAndSet(false, true)) {
      dropped += 1
      return
    }
    // sensor-session 側の Image は finally で close されるので、必要なバイト列を inline で copy。
    val width = image.width
    val height = image.height
    val nv21 = imageToNv21(image)

    mlHandler.post {
      try {
        val bitmap = nv21ToArgbBitmap(nv21, width, height, sensorOrientation)
        val hands = detector.detect(bitmap)
        synchronized(framesLock) {
          frames.add(HandPoseFrame(frame_index = frameIndex, ts_ns = timestampNs, hands = hands))
        }
        bitmap.recycle()
      } catch (t: Throwable) {
        Log.w(TAG, "ML inference failed at frame=$frameIndex: ${t.message}", t)
      } finally {
        processing.set(false)
      }
    }
  }

  /** 累積 frame buffer を取り出してクリア。stream stop 時に呼ぶ。 */
  fun drainFrames(): List<HandPoseFrame> {
    synchronized(framesLock) {
      val snapshot = frames.toList()
      frames.clear()
      return snapshot
    }
  }

  fun reset() {
    synchronized(framesLock) { frames.clear() }
    dropped = 0L
  }

  fun close() {
    mlHandler.removeCallbacksAndMessages(null)
    mlThread.quitSafely()
  }

  // ----- Image conversion helpers -----

  /**
   * Camera2 YUV_420_888 Image → NV21 ByteArray。
   * pixelStride / rowStride を考慮した安全変換 (Pixel 10 / Seeker でも通る)。
   */
  private fun imageToNv21(image: Image): ByteArray {
    val width = image.width
    val height = image.height
    val ySize = width * height
    val uvSize = ySize / 2
    val nv21 = ByteArray(ySize + uvSize)

    // Y plane
    val yPlane = image.planes[0]
    copyPlaneInterleaved(
      src = yPlane.buffer, dst = nv21, dstOffset = 0,
      width = width, height = height,
      rowStride = yPlane.rowStride, pixelStride = yPlane.pixelStride
    )

    // VU interleaved (NV21 = YYYY...VUVUVU)
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]
    val uBuf = uPlane.buffer
    val vBuf = vPlane.buffer
    val uvWidth = width / 2
    val uvHeight = height / 2
    val vRowStride = vPlane.rowStride
    val vPixelStride = vPlane.pixelStride
    val uRowStride = uPlane.rowStride
    val uPixelStride = uPlane.pixelStride

    var dst = ySize
    val uRow = ByteArray(uRowStride)
    val vRow = ByteArray(vRowStride)
    for (row in 0 until uvHeight) {
      uBuf.position(row * uRowStride)
      uBuf.get(uRow, 0, minOf(uRowStride, uBuf.remaining()))
      vBuf.position(row * vRowStride)
      vBuf.get(vRow, 0, minOf(vRowStride, vBuf.remaining()))
      for (col in 0 until uvWidth) {
        nv21[dst++] = vRow[col * vPixelStride]
        nv21[dst++] = uRow[col * uPixelStride]
      }
    }
    return nv21
  }

  private fun copyPlaneInterleaved(
    src: java.nio.ByteBuffer, dst: ByteArray, dstOffset: Int,
    width: Int, height: Int, rowStride: Int, pixelStride: Int
  ) {
    if (pixelStride == 1 && rowStride == width) {
      src.get(dst, dstOffset, width * height)
      return
    }
    val tmp = ByteArray(rowStride)
    var d = dstOffset
    for (row in 0 until height) {
      src.position(row * rowStride)
      src.get(tmp, 0, minOf(rowStride, src.remaining()))
      if (pixelStride == 1) {
        System.arraycopy(tmp, 0, dst, d, width)
        d += width
      } else {
        for (col in 0 until width) dst[d++] = tmp[col * pixelStride]
      }
    }
  }

  /**
   * NV21 → JPEG → ARGB Bitmap → optional rotation。
   * YuvImage 経由が hardware decode で速い (Bitmap pixel data は ARGB_8888)。
   */
  private fun nv21ToArgbBitmap(nv21: ByteArray, width: Int, height: Int, rotationDeg: Int): Bitmap {
    val yuv = YuvImage(nv21, ImageFormat.NV21, width, height, null)
    val out = ByteArrayOutputStream()
    yuv.compressToJpeg(Rect(0, 0, width, height), 85, out)
    val jpegBytes = out.toByteArray()
    val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val bitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size, opts)
    return if (rotationDeg != 0) {
      val matrix = Matrix().apply { postRotate(rotationDeg.toFloat()) }
      val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
      bitmap.recycle()
      rotated
    } else bitmap
  }
}
