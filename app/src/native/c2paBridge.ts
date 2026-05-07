import { requireOptionalNativeModule } from 'expo-modules-core';

// C2PA 署名ネイティブブリッジ (v0.0.1 task 07)。
// Android: app/modules/c2pa-bridge/android (Rust .so + JNI shim 経由)
// iOS:    app/modules/c2pa-bridge/ios (libc2pa_rs*.a 経由) — task 07 では Android のみ verify
//
// dev mode: self-signed cert chain (scripts/gen-dev-certs.sh で生成) を使う。
// production (TEE / RootLens CA / TSA) は task 09+ で対応。

interface C2paBridgeNativeModule {
  signMp4(
    inputPath: string,
    outputPath: string,
    certChainPem: string,
    privateKeyPem: string,
  ): Promise<string>;
  readManifest(inputPath: string): Promise<string | null>;
  getVersion(): string;
}

const nativeImpl = requireOptionalNativeModule<C2paBridgeNativeModule>('C2paBridge');

export function isC2paAvailable(): boolean {
  return nativeImpl !== null;
}

/**
 * mp4 (もしくは jpeg) を C2PA 署名する。
 *  - inputPath / outputPath は file:// 付きでも生 path でも OK (native 側で剥がす)
 *  - certChainPem は device cert + root CA を連結した PEM 文字列
 *  - privateKeyPem は device 秘密鍵 PEM
 *  - 戻り値は出力 file:// URI
 */
export async function signMp4(
  inputPath: string,
  outputPath: string,
  certChainPem: string,
  privateKeyPem: string,
): Promise<string> {
  if (!nativeImpl) throw new Error('C2paBridge native module unavailable');
  return nativeImpl.signMp4(inputPath, outputPath, certChainPem, privateKeyPem);
}

/**
 * 既存ファイルの manifest を JSON 文字列として読み出す。manifest 無ければ null。
 */
export async function readC2paManifest(inputPath: string): Promise<string | null> {
  if (!nativeImpl) return null;
  return nativeImpl.readManifest(inputPath);
}

export function getC2paVersion(): string {
  if (!nativeImpl) return 'unavailable';
  try {
    return nativeImpl.getVersion();
  } catch {
    return 'unknown';
  }
}
