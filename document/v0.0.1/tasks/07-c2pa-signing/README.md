# Task 07: C2PA 署名 — root-lens c2pa-bridge を移植 (self-signed dev cert)

## 目的

仕様書 §2.7 の **撮影終了時に C2PA 署名を付与** を満たす。task 06 で出る `clip_<id>.mp4` を署名済 mp4 (C2PA manifest 埋め込み済) に置き換え、改竄なしの証明をクリップに乗せる。

スコープを v0.0.1 に絞り:
- **TEE (Secure Enclave / StrongBox) は使わない** — 開発用 self-signed cert chain (`scripts/gen-dev-certs.sh` 生成) で署名
- **動的 assertion 注入は最小** — `c2pa.actions (c2pa.created)` 標準 assertion のみ。sensor data / device info の C2PA assertion 化は task 09 候補
- **iOS / Android 両 platform で `c2patool` 検証が通る mp4 が出る**ところまで

## 仕様書参照

- §2.7 撮影時の C2PA 署名 (TEE 鍵管理は別途仕様書で定義 — 本タスクの範囲外)

## 移植元 (root-lens から)

| 元 | 行数 | 内容 | 我々のリポでの置き場 |
|---|---|---|---|
| `native/c2pa-bridge/src/lib.rs` | 705 | Rust crate (c2pa-rs ラッパー + 動的 assertion 注入 + TEE callback API) | `native/c2pa-bridge/src/lib.rs` |
| `native/c2pa-bridge/Cargo.{toml,lock}` | - | crate 定義 (c2pa-rs 依存等) | 同上 |
| `native/c2pa-bridge/c2pa_bridge.h` | - | C ABI ヘッダ | 同上 |
| `app/modules/c2pa-bridge/ios/C2paBridgeModule.swift` | 1016 | iOS Expo Module (大きいが多くは TEE / video editing 周り、本タスクでは subset を移植) | `app/modules/c2pa-bridge/ios/` |
| `app/modules/c2pa-bridge/ios/lib/libc2pa_rs*.a` | - | iOS prebuilt static lib (device + sim + universal) | 同上 |
| `app/modules/c2pa-bridge/ios/c2pa_bridge.{h,podspec}` + `module.modulemap` | - | iOS bridging | 同上 |
| `app/android/app/src/main/jni/c2pa_jni.c` | - | JNI C shim | `app/modules/c2pa-bridge/android/src/main/jni/c2pa_jni.c` |
| `app/android/app/src/main/jniLibs/{arm64-v8a,x86_64}/libc2pa_jni.so` | 8.9KB | JNI shim prebuilt | `app/modules/c2pa-bridge/android/src/main/jniLibs/<abi>/libc2pa_jni.so` |
| `app/android/app/src/main/jniLibs/{arm64-v8a,x86_64}/libc2pa_bridge.so` | 13MB | Rust crate prebuilt | 同上 |
| `app/android/app/src/main/java/io/rootlens/app/C2paBridgeModule.kt` | huge | RN Bridge Module (BouncyCastle / Media3 編集 / TEE keygen 等が混在) | **書き直し**: 最小 Expo Module として作り直す (TEE / 動画編集 / key 生成は v0.0.1 不要) |
| `app/src/native/c2paBridge.ts` | 241 | TS bridge | `app/src/native/c2paBridge.ts` |
| `scripts/gen-dev-certs.sh` | - | self-signed dev cert chain 生成 (Root CA + Device cert) | 同上 |

### 書き直す理由 (Android Kotlin)

root-lens の `C2paBridgeModule.kt` は v0.1.0 までの蓄積で:
- TEE keygen (`KeyGenParameterSpec`)
- BouncyCastle で device CSR 生成
- Media3 Transformer で動画編集
- Android Keystore 経由の鍵管理

が全部入っている。我々の v0.0.1 task 07 は「mp4 を self-signed cert で sign する」だけなので、最低限の AsyncFunction (`signMp4(input, output, certChainPath, privateKeyPath)`) を持つ薄い Expo Module として新規実装する。

iOS Swift も同様に subset 移植 (今は editing / TEE 不要)。

## 設計

### 鍵 / 証明書の置き場 (v0.0.1 dev mode)

```
app/dev-certs/                  ← scripts/gen-dev-certs.sh 出力 (gitignore 推奨)
├── dev-chain.pem               ← Device cert + Root CA (PEM concat)
├── dev-device-key.pem          ← Device 秘密鍵 (PEM)
└── (Root CA / 公開鍵類)
```

dev mode では PEM を直接ファイルから読む。production (v0.1.0+) で TEE-backed key + RootLens CA に切替予定。

### 署名フロー

```
[CaptureView finalizing]
   ├─→ nativeStopStream → mp4 path
   ├─→ stopHandPose → hand_pose frames
   ├─→ saveSidecar → clip_<id>.json
   └─→ signMp4Inplace(clip_<id>.mp4, devChainPath, devKeyPath)
         │
         └─→ Expo Module C2paBridge.signMp4
                │
                └─→ JNI / FFI → c2pa-rs で manifest 構築 + 署名 + 埋め込み
                       │
                       └─→ 署名済 mp4 を上書き or new file → URI 返却
```

C2PA manifest 内容 (最小):

```json
{
  "claim_generator_info": [{ "name": "rootlens-mobile", "version": "0.0.1" }],
  "assertions": [
    { "label": "c2pa.actions", "data": { "actions": [{ "action": "c2pa.created" }] } }
  ]
}
```

将来 task 09 で:
- `io.rootlens.capture.device` (device info)
- `io.rootlens.capture.sensor.imu` (IMU sample digest)
- `io.rootlens.capture.hand_pose` (sidecar JSON path or digest)

を assertions[] に追加する想定 (root-lens v0.1.1 task 02 の `c2pa_sign_image_tee_with_assertions` と同等)。

## 実装内容

1. **Rust crate 移植**: `native/c2pa-bridge/` (Cargo.toml + src/lib.rs + c2pa_bridge.h)
   - そのままコピー。本タスクではビルドしない (root-lens の prebuilt .so / .a を流用)。
   - 将来 rebuild 時のために `cargo ndk` ワークフロー document は別途。

2. **iOS Expo Module 移植**: `app/modules/c2pa-bridge/ios/`
   - Swift / podspec / header / modulemap / 3 つの `.a` ライブラリ
   - C2paBridgeModule.swift は本タスクで使う AsyncFunction (`signMp4`) のみ残し、それ以外 (TEE keygen / editing) はコメントアウトもしくは別ファイルに分離

3. **Android Expo Module 新規** (Kotlin 書き直し): `app/modules/c2pa-bridge/android/`
   - `build.gradle` + `expo-module.config.json` + `AndroidManifest.xml`
   - `src/main/jni/c2pa_jni.c` + `src/main/jniLibs/{arm64-v8a,x86_64}/lib*.so` (root-lens prebuilt 流用)
   - `src/main/java/io/rootlens/c2pa/C2paBridgeModule.kt` — Expo Module 形式の薄い wrapper。`signMp4` AsyncFunction のみ

4. **TS bridge**: `app/src/native/c2paBridge.ts`
   - root-lens 版から TEE / cert chain rotation 周りを除き、`signMp4` の薄い API のみ残す

5. **dev cert 生成**: `scripts/gen-dev-certs.sh` を root-lens から copy。`.gitignore` に `app/dev-certs/` 追加 (秘密鍵をリポジトリに入れない)。

6. **CaptureView 統合**: `saveSidecar` 後に `signMp4Inplace(videoUri, chainPath, keyPath)` を呼び出し、署名済 mp4 で `videoUri` を上書き。result view にも反映。

7. **検証**:
   - Pixel 10 で 1 clip 撮影 → `adb pull /data/.../clip_*.mp4` で取り出し
   - Mac で `brew install c2patool` 後 `c2patool clip_*.mp4 --info` を叩いて manifest valid + cert chain 表示

## 完了条件

- [ ] `native/c2pa-bridge/` (Rust) 移植 (build はしない)
- [ ] iOS Expo Module subset 移植 (`signMp4` AsyncFunction のみ動く)
- [ ] Android Expo Module 新規 (Kotlin + JNI .so + Rust .so の prebuilt 4 ファイル流用)
- [ ] `app/src/native/c2paBridge.ts` 移植
- [ ] `scripts/gen-dev-certs.sh` 移植 + `.gitignore` 更新 (dev-certs を除外)
- [ ] dev cert chain 生成完了 (`app/dev-certs/dev-chain.pem` + `dev-device-key.pem`)
- [ ] CaptureView の finalize で `signMp4Inplace` を呼び、署名済 mp4 で sidecar の videoUri を上書き
- [ ] `tsc --noEmit` pass
- [ ] `expo-doctor` pass
- [ ] Pixel 10 で C2PA 署名済 mp4 が出力される
- [ ] Mac の `c2patool` で manifest が valid と確認できる

## スコープ外 (後続タスク)

- **TEE (Secure Enclave / StrongBox) 鍵管理** — task 09 候補 (本タスクは file-based PEM)
- **RootLens Production CA** — 開発 self-signed のみ
- **動的 assertion 注入** (sensor data / device info の C2PA assertion 化) — task 09 候補
- **TSA (RFC 3161) timestamp** — production 向け
- **iOS 実機検証** — Android (Pixel 10) のみ verify。iOS は build 通るところまで

## 参考: root-lens の罠 (引き継ぎ事項)

- root-lens v0.1.0/12-tsa-timestamp-fix で「TSA timestamp が CMS signature 計算前に追加される必要がある」ことを修正済 — 我々は TSA 不採用なので関係なし
- v0.1.1/02 の lib.rs L293-316 改修 (動的 assertion 注入対応) — 既に root-lens の lib.rs に入っている、移植時はそのまま
- 「c2patool nested array 表示バグ」(POSTMORTEM v0.1.1 task 02 #8) は表示のみで署名検証には無関係
