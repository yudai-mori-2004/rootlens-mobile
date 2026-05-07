package io.rootlens.app

import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * C2PA 署名 Expo Module (Android)。
 *
 * Rust c2pa-rs (libc2pa_bridge.so) を JNI shim (libc2pa_jni.so) 経由で呼び出す。
 * 両 .so は root-lens 由来の prebuilt を `src/main/jniLibs/<abi>/` に同梱
 * (rebuild 手順は scripts/ に別途用意予定)。
 *
 * v0.0.1 task 07 のスコープでは self-signed cert chain を使う minimal な
 * `signMp4` のみ公開する。TEE / production CA / 動的 assertion 注入 / video
 * editing は task 09+ で順次足す。
 *
 * パッケージ重要: `io.rootlens.app` で固定。.so の JNI symbol が
 * `Java_io_rootlens_app_C2paBridgeModule_*` で焼かれているため、別 package に
 * 置くと UnsatisfiedLinkError になる。
 */
class C2paBridgeModule : Module() {

  companion object {
    private const val TAG = "C2paBridge"
    init {
      // c2pa_bridge (Rust) → c2pa_jni (JNI shim) の順で load。
      // c2pa_jni は c2pa_bridge の symbol に依存するため逆順は ld 失敗する。
      System.loadLibrary("c2pa_bridge")
      System.loadLibrary("c2pa_jni")
    }
  }

  // ----- JNI native function declarations (shared with root-lens) -----

  /**
   * 自己署名 cert chain で sign。TEE は使わず PEM 文字列を直接渡す。
   * @return 0 成功 / 非 0 失敗 (詳細 code は c2pa_bridge/lib.rs 参照)
   */
  private external fun nativeSignImage(
    inputPath: String,
    outputPath: String,
    certChainPem: String,
    privateKeyPem: String,
  ): Int

  /** 入力ファイルの C2PA manifest を JSON 文字列で取得。manifest なしなら空文字列。 */
  private external fun nativeReadManifest(inputPath: String): String

  /** c2pa-rs のバージョン文字列。診断用。 */
  private external fun nativeGetVersion(): String

  // ----- Expo Module definition -----

  override fun definition() = ModuleDefinition {
    Name("C2paBridge")

    /**
     * mp4 (もしくは jpeg) を C2PA 署名する。
     * - inputPath: file:// 抜きの絶対パス
     * - outputPath: 同上 (input と異なる場所推奨。実装側で input を書き換えても良い)
     * - certChainPem: device cert + root CA を連結した PEM 文字列
     * - privateKeyPem: device 秘密鍵 PEM
     */
    AsyncFunction("signMp4") {
      inputPath: String,
      outputPath: String,
      certChainPem: String,
      privateKeyPem: String,
      promise: Promise ->

      try {
        val cleanInput = inputPath.removePrefix("file://")
        val cleanOutput = outputPath.removePrefix("file://")
        val rc = nativeSignImage(cleanInput, cleanOutput, certChainPem, privateKeyPem)
        if (rc == 0) {
          Log.i(TAG, "signMp4 OK: $cleanOutput")
          promise.resolve("file://$cleanOutput")
        } else {
          promise.reject("C2PA_SIGN_ERROR", "nativeSignImage rc=$rc", null)
        }
      } catch (t: Throwable) {
        promise.reject("C2PA_SIGN_ERROR", t.message ?: "signMp4 failed", t)
      }
    }

    /**
     * 既存ファイルの manifest を JSON で読み出す。manifest 無ければ null 返却。
     */
    AsyncFunction("readManifest") { inputPath: String, promise: Promise ->
      try {
        val cleanInput = inputPath.removePrefix("file://")
        val json = nativeReadManifest(cleanInput)
        if (json.isEmpty()) promise.resolve(null) else promise.resolve(json)
      } catch (t: Throwable) {
        promise.reject("C2PA_READ_MANIFEST_ERROR", t.message ?: "readManifest failed", t)
      }
    }

    /** c2pa-rs のバージョン文字列を返す (診断用)。 */
    Function("getVersion") {
      try { nativeGetVersion() } catch (t: Throwable) { "unknown: ${t.message}" }
    }
  }
}
