package io.rootlens.handpose

// Hand pose schema (server fusion 用 sidecar に格納される per-frame landmark 構造)。
// 21 landmark は MediaPipe HandLandmarker native の index 規約に従う。
//  0: WRIST
//  1-4: THUMB (CMC, MCP, IP, TIP)
//  5-8: INDEX (MCP, PIP, DIP, TIP)
//  9-12: MIDDLE
// 13-16: RING
// 17-20: PINKY

data class HandLandmark(
  val x: Float,             // image-normalized [0,1], top-left origin
  val y: Float,
  val z: Float,             // wrist-relative depth (MediaPipe relative)
  val confidence: Float
) {
  fun toMap(): Map<String, Any> = mapOf("x" to x, "y" to y, "z" to z, "confidence" to confidence)
}

data class HandWorldLandmark(
  // hand 重心原点の 3D メートル座標 (MediaPipe worldLandmarks)
  val x_m: Float,
  val y_m: Float,
  val z_m: Float
) {
  fun toMap(): Map<String, Any> = mapOf("x_m" to x_m, "y_m" to y_m, "z_m" to z_m)
}

data class HandObservation(
  val handedness: String,   // "left" | "right" | "unknown"
  val score: Float,
  val landmarks: List<HandLandmark>,             // 必ず 21
  val world_landmarks: List<HandWorldLandmark>?  // Android のみ非 null
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "handedness" to handedness,
    "score" to score,
    "landmarks" to landmarks.map { it.toMap() },
    "world_landmarks" to world_landmarks?.map { it.toMap() }
  )
}

/** sensor-session の analysis stream の各 frame に対する検出結果。 */
data class HandPoseFrame(
  val frame_index: Long,
  val ts_ns: Long,
  val hands: List<HandObservation>
) {
  fun toMap(): Map<String, Any> = mapOf(
    "frame_index" to frame_index,
    "ts_ns" to ts_ns.toULong().toString(),
    "hands" to hands.map { it.toMap() }
  )
}
