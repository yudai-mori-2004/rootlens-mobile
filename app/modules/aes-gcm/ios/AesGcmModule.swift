import ExpoModulesCore
import CryptoKit
import Foundation

// AES-256-GCM Expo Module — root-lens RN bridge 版を Expo Module に書き直したもの。
// 仕様書 §6.1 (TP 登録 E2EE) で使用。Android Kotlin 版と入出力 schema 一致。

public class AesGcmModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AesGcmBridge")

    AsyncFunction("buildAndEncryptPayload") { (
      contentFilePath: String,
      metadataJson: String,
      requestKeyBase64: String,
      encapKeyBase64: String,
      aadString: String,
      outputFilePath: String,
      promise: Promise
    ) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard let key = Data(base64Encoded: requestKeyBase64) else {
            throw AesGcmError.invalidBase64("requestKey")
          }
          guard let encapKey = Data(base64Encoded: encapKeyBase64) else {
            throw AesGcmError.invalidBase64("encapKey")
          }
          guard let aad = aadString.data(using: .utf8) else {
            throw AesGcmError.invalidEncoding("aad")
          }
          guard let metaBytes = metadataJson.data(using: .utf8) else {
            throw AesGcmError.invalidEncoding("metadata")
          }
          let content = try Data(contentsOf: URL(fileURLWithPath: contentFilePath))

          // plaintext: [4B meta_len BE][metadata][content]
          var metaLen = UInt32(metaBytes.count).bigEndian
          var plaintext = Data(bytes: &metaLen, count: 4)
          plaintext.append(metaBytes)
          plaintext.append(content)

          // AES-256-GCM with AAD
          let symmetricKey = SymmetricKey(data: key)
          let nonce = AES.GCM.Nonce()
          let sealedBox = try AES.GCM.seal(
            plaintext,
            using: symmetricKey,
            nonce: nonce,
            authenticating: aad
          )

          // wire format v1: [suite_id(1B)][encap_key_len(2B BE)][encap_key][nonce(12B)][ct+tag]
          let suiteId: UInt8 = 0x01
          var encapKeyLen = UInt16(encapKey.count).bigEndian

          var output = Data()
          output.append(suiteId)
          output.append(Data(bytes: &encapKeyLen, count: 2))
          output.append(encapKey)
          output.append(contentsOf: sealedBox.nonce)
          output.append(sealedBox.ciphertext)
          output.append(sealedBox.tag)

          try output.write(to: URL(fileURLWithPath: outputFilePath))
          promise.resolve(["size": output.count])
        } catch {
          promise.reject("BUILD_ENCRYPT_ERROR", error.localizedDescription)
        }
      }
    }

    AsyncFunction("encryptFile") { (
      inputPath: String,
      outputPath: String,
      keyBase64: String,
      aadBase64: String,
      promise: Promise
    ) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard let key = Data(base64Encoded: keyBase64) else {
            throw AesGcmError.invalidBase64("key")
          }
          guard let aad = Data(base64Encoded: aadBase64) else {
            throw AesGcmError.invalidBase64("aad")
          }
          let plaintext = try Data(contentsOf: URL(fileURLWithPath: inputPath))

          let symmetricKey = SymmetricKey(data: key)
          let sealedBox = try AES.GCM.seal(plaintext, using: symmetricKey, authenticating: aad)

          // Android cipher.doFinal() = ciphertext + tag (16 byte) で揃える
          var ciphertextWithTag = Data(sealedBox.ciphertext)
          ciphertextWithTag.append(sealedBox.tag)
          try ciphertextWithTag.write(to: URL(fileURLWithPath: outputPath))

          let nonceBase64 = Data(sealedBox.nonce).base64EncodedString()
          promise.resolve(["nonce": nonceBase64, "size": ciphertextWithTag.count])
        } catch {
          promise.reject("AES_ENCRYPT_FILE_ERROR", error.localizedDescription)
        }
      }
    }

    AsyncFunction("decryptFile") { (
      inputPath: String,
      outputPath: String,
      keyBase64: String,
      nonceBase64: String,
      aadBase64: String,
      promise: Promise
    ) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard let key = Data(base64Encoded: keyBase64) else {
            throw AesGcmError.invalidBase64("key")
          }
          guard let nonceData = Data(base64Encoded: nonceBase64) else {
            throw AesGcmError.invalidBase64("nonce")
          }
          guard let aad = Data(base64Encoded: aadBase64) else {
            throw AesGcmError.invalidBase64("aad")
          }
          let ciphertextWithTag = try Data(contentsOf: URL(fileURLWithPath: inputPath))

          let symmetricKey = SymmetricKey(data: key)
          let nonce = try AES.GCM.Nonce(data: nonceData)

          let tagSize = 16
          guard ciphertextWithTag.count >= tagSize else {
            throw AesGcmError.dataTooShort
          }
          let ciphertext = ciphertextWithTag.prefix(ciphertextWithTag.count - tagSize)
          let tag = ciphertextWithTag.suffix(tagSize)

          let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
          let plaintext = try AES.GCM.open(sealedBox, using: symmetricKey, authenticating: aad)

          try plaintext.write(to: URL(fileURLWithPath: outputPath))
          promise.resolve(outputPath)
        } catch {
          promise.reject("AES_DECRYPT_FILE_ERROR", error.localizedDescription)
        }
      }
    }
  }
}

private enum AesGcmError: LocalizedError {
  case invalidBase64(String)
  case invalidEncoding(String)
  case dataTooShort

  var errorDescription: String? {
    switch self {
    case .invalidBase64(let field): return "Invalid base64 for \(field)"
    case .invalidEncoding(let field): return "Invalid UTF-8 encoding for \(field)"
    case .dataTooShort: return "Ciphertext too short (must include 16-byte GCM tag)"
    }
  }
}
