package io.rootlens.handpose

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.ByteBufferImageBuilder
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult
import java.nio.ByteBuffer

/**
 * MediaPipe HandLandmarker (IMAGE mode + CPU delegate) の薄ラッパー。
 *
 * Solana Seeker (Android 16) で MediaPipe 0.10.20 + BitmapImageBuilder の native
 * JNI が SIGSEGV する不具合を踏まえ、0.10.29 + ByteBufferImageBuilder 経由で
 * RGBA byte buffer を直接渡す経路を採用。
 */
class HandPoseDetector(context: Context) {
  private val handLandmarker: HandLandmarker

  init {
    val baseOptions = BaseOptions.builder()
      .setModelAssetPath(MODEL_ASSET_PATH)
      .setDelegate(Delegate.CPU)
      .build()

    val options = HandLandmarker.HandLandmarkerOptions.builder()
      .setBaseOptions(baseOptions)
      .setNumHands(MAX_HANDS)
      .setMinHandDetectionConfidence(0.5f)
      .setMinHandPresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setRunningMode(RunningMode.IMAGE)
      .build()

    handLandmarker = HandLandmarker.createFromOptions(context, options)
  }

  fun detect(bitmap: Bitmap): List<HandObservation> {
    val width = bitmap.width
    val height = bitmap.height
    val byteBuffer = ByteBuffer.allocateDirect(width * height * 4)
    bitmap.copyPixelsToBuffer(byteBuffer)
    byteBuffer.rewind()

    val mpImage: MPImage = ByteBufferImageBuilder(
      byteBuffer, width, height, MPImage.IMAGE_FORMAT_RGBA
    ).build()
    val result: HandLandmarkerResult = handLandmarker.detect(mpImage)
    return convert(result)
  }

  fun close() { handLandmarker.close() }

  private fun convert(result: HandLandmarkerResult): List<HandObservation> {
    val hands = result.landmarks()
    val worldLandmarksList = result.worldLandmarks()
    val handednessList = result.handedness()
    val out = mutableListOf<HandObservation>()

    for (i in hands.indices) {
      val frameLandmarks = hands[i]
      val landmarks = ArrayList<HandLandmark>(21)
      for (lm in frameLandmarks) {
        landmarks.add(
          HandLandmark(
            x = lm.x(), y = lm.y(), z = lm.z(),
            confidence = if (lm.visibility().isPresent) lm.visibility().get() else 1.0f
          )
        )
      }
      while (landmarks.size < 21) landmarks.add(HandLandmark(0f, 0f, 0f, 0f))
      val trimmedLandmarks = if (landmarks.size > 21) landmarks.subList(0, 21).toList() else landmarks

      val world: List<HandWorldLandmark>? =
        if (i < worldLandmarksList.size) {
          worldLandmarksList[i].map { HandWorldLandmark(it.x(), it.y(), it.z()) }
        } else null

      val handLabel: String
      val score: Float
      if (i < handednessList.size && handednessList[i].isNotEmpty()) {
        val top = handednessList[i][0]
        handLabel = top.categoryName().lowercase()
        score = top.score()
      } else {
        handLabel = "unknown"
        score = 0f
      }

      out.add(
        HandObservation(
          handedness = handLabel,
          score = score,
          landmarks = trimmedLandmarks,
          world_landmarks = world
        )
      )
    }
    return out
  }

  companion object {
    private const val MODEL_ASSET_PATH = "hand_landmarker.task"
    private const val MAX_HANDS = 2
  }
}
