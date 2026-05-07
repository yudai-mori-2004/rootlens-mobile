package io.rootlens.aesgcm

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Native AES-256-GCM (Expo Module 形式)。root-lens v0.1.0 task 18 の RN bridge 版を
 * Expo Module に書き直したもの。仕様書 §6.1 (TP 登録 E2EE channel) で使用。
 *
 * javax.crypto (Android builtin) を使う。追加依存ゼロ。
 * ARMv8 の AES hardware 命令を自動利用。
 */
class AesGcmModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AesGcmBridge")

    /**
     * バイナリペイロード構築 + AES-256-GCM 暗号化を native で一括実行。
     * 5MB級コンテンツが JS↔Native bridge を通過しない。
     *
     * plaintext: [4B meta_len BE][metadata][content_file_bytes]
     * output:    [suite_id(1B)][encap_key_len(2B BE)][encap_key][nonce(12B)][ciphertext+tag]
     */
    AsyncFunction("buildAndEncryptPayload") {
      contentFilePath: String,
      metadataJson: String,
      requestKeyBase64: String,
      encapKeyBase64: String,
      aadString: String,
      outputFilePath: String,
      promise: Promise ->

      try {
        val key = Base64.decode(requestKeyBase64, Base64.NO_WRAP)
        val encapKey = Base64.decode(encapKeyBase64, Base64.NO_WRAP)
        val aad = aadString.toByteArray(Charsets.UTF_8)
        val metaBytes = metadataJson.toByteArray(Charsets.UTF_8)
        val content = File(contentFilePath).readBytes()

        val metaLen = ByteBuffer.allocate(4).putInt(metaBytes.size).array()
        val plaintext = metaLen + metaBytes + content

        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        val ciphertext = cipher.doFinal(plaintext)

        val suiteId: Byte = 0x01  // X25519-AES-256-GCM
        val encapKeyLen = ByteBuffer.allocate(2).putShort(encapKey.size.toShort()).array()

        FileOutputStream(outputFilePath).use { out ->
          out.write(byteArrayOf(suiteId))
          out.write(encapKeyLen)
          out.write(encapKey)
          out.write(nonce)
          out.write(ciphertext)
        }

        val totalSize = 1 + 2 + encapKey.size + nonce.size + ciphertext.size
        promise.resolve(mapOf("size" to totalSize))
      } catch (e: Throwable) {
        promise.reject("BUILD_ENCRYPT_ERROR", e.message ?: "buildAndEncryptPayload failed", e)
      }
    }

    /** AES-256-GCM file → file 暗号化 (AAD 付き)。Bridge を大容量データが通らない。 */
    AsyncFunction("encryptFile") {
      inputPath: String,
      outputPath: String,
      keyBase64: String,
      aadBase64: String,
      promise: Promise ->

      try {
        val key = Base64.decode(keyBase64, Base64.NO_WRAP)
        val aad = Base64.decode(aadBase64, Base64.NO_WRAP)
        val plaintext = File(inputPath).readBytes()

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
        cipher.updateAAD(aad)
        val ciphertextWithTag = cipher.doFinal(plaintext)

        File(outputPath).outputStream().use { it.write(ciphertextWithTag) }

        promise.resolve(mapOf(
          "nonce" to Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
          "size" to ciphertextWithTag.size,
        ))
      } catch (e: Throwable) {
        promise.reject("AES_ENCRYPT_FILE_ERROR", e.message ?: "encryptFile failed", e)
      }
    }

    /** AES-256-GCM file → file 復号 (AAD 付き)。 */
    AsyncFunction("decryptFile") {
      inputPath: String,
      outputPath: String,
      keyBase64: String,
      nonceBase64: String,
      aadBase64: String,
      promise: Promise ->

      try {
        val key = Base64.decode(keyBase64, Base64.NO_WRAP)
        val nonce = Base64.decode(nonceBase64, Base64.NO_WRAP)
        val aad = Base64.decode(aadBase64, Base64.NO_WRAP)
        val ciphertext = File(inputPath).readBytes()

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        val plaintext = cipher.doFinal(ciphertext)

        File(outputPath).writeBytes(plaintext)
        promise.resolve(outputPath)
      } catch (e: Throwable) {
        promise.reject("AES_DECRYPT_FILE_ERROR", e.message ?: "decryptFile failed", e)
      }
    }
  }
}
