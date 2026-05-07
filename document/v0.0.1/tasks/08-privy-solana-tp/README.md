# Task 08: Privy + Solana embedded wallet + Title Protocol 登録

## 目的

仕様書 §1.3 (Privy / Solana / TP 外部依存) と §3 (TP 経由 Core NFT 発行) を満たす。
撮影完了 → C2PA 署名済 mp4 → TP Gateway に送信 → Solana 上で Core NFT mint
までを Pixel 10 で end-to-end で動かす。

買取 (§4) のコントラクト書き直しは task 10 に分離。本タスクは「クリップを TP に置き、Core NFT を受け取る」ところまで。

## 仕様書参照

- §1.3 外部依存 (Privy / Solana / TP)
- §3 Title Protocol の利用範囲 (C2PA 検証 + Core NFT 発行)
- §3.2 TP はステートレス (重複は app 層で排除)
- §3.3 Core NFT の意味 (撮影証明 + ライセンス発行権)
- §7 権利の流れ (撮影 → 利用規約同意 → Core NFT 発行)

## 移植元 (root-lens から、ほぼそのまま)

| 元 | 行数 | 役割 | 我々の置き場 |
|---|---|---|---|
| `legacy/v0.1.1/app-src/App.tsx` (PrivyProvider 周り) | excerpt | `PrivyProvider` + `embedded.solana.createOnLogin` 設定 | `app/App.tsx` (Stack root を PrivyProvider で wrap) |
| `legacy/v0.1.1/app-src/hooks/useAuth.ts` | 21 | `usePrivy` + `useEmbeddedSolanaWallet` 薄ラッパー | `app/src/hooks/useAuth.ts` |
| `legacy/v0.1.1/app-src/services/titleProtocol.ts` | 186 | TP SDK + AES-GCM 暗号化 + extension 解決 | `app/src/services/titleProtocol.ts` |
| `legacy/v0.1.1/app-src/services/nativeCryptoProvider.ts` | 120 | TEE crypto bridge (TP の x25519 + signing で使用) | `app/src/services/nativeCryptoProvider.ts` |
| `legacy/v0.1.1/app-src/screens/RegistrationScreen.tsx` | 206 | login UI (Privy `useLogin`) | `app/src/screens/RegistrationScreen.tsx` |
| `legacy/v0.1.1/app-src/screens/PublishingScreen.tsx` (subset) | 555 | TP 登録進捗 UI。本タスクではエラー表示等の UX 部分は最小限で OK | `app/src/screens/PublishingScreen.tsx` |
| `app/shim.ts` | 52 | crypto polyfill (Privy / @noble 用) | `app/shim.ts` |
| `app/ios/RootLens/AesGcmModule.{swift,m}` | 177 | AES-GCM 暗号 (TP encrypted upload 用) — RN Bridge 形式 | **書き直し**: `app/modules/aes-gcm/ios/` を Expo Module 形式で |
| `app/android/app/src/main/java/io/rootlens/app/AesGcmModule.kt` | 134 | 同上 (Android) | **書き直し**: `app/modules/aes-gcm/android/` を Expo Module 形式で |

## 設計

### 鍵 / 認証

- Privy embedded Solana wallet で device 鍵を生成 (`createOnLogin: 'users-without-wallets'`)
- TP の暗号化用 x25519 鍵 / 署名は `nativeCryptoProvider` 経由で TEE-backed (root-lens の C2paBridge/TEE 系と同じ keystore)
- 本タスクでは production CA に届けない (self-signed と同じ流れ。Privy 側の wallet 鍵は本物の Solana 鍵)

### CaptureView 統合

```
finalizing useEffect (既存 task 06 + 07)
  ├─→ stopHandPose / nativeStopStream (mp4 finalize)
  ├─→ saveSidecar (clip_<id>.json)
  ├─→ signMp4 (C2PA 署名)
  └─→ NEW: registerToTP(signedMp4Path, sidecarPath, walletAddress)
         └─→ services/titleProtocol.ts → TP Gateway (AES-GCM encrypted) → Core NFT mint tx
            └─→ tx hash + content hash を sidecar.trust に追記
```

### 必要な環境変数 (`app/.env`)

```bash
EXPO_PUBLIC_PRIVY_APP_ID=...           # Privy dashboard で発行
EXPO_PUBLIC_PRIVY_CLIENT_ID=...        # 同上
EXPO_PUBLIC_TP_GATEWAY_URL=...         # TP Gateway endpoint (devnet 用)
EXPO_PUBLIC_SOLANA_RPC_URL=...         # devnet RPC (Helius 等)
```

これらは `.env` に置き、`process.env.EXPO_PUBLIC_*` で読む。VLM API key と同じ運用。

### AES-GCM Expo Module (書き直し)

root-lens の AesGcmModule.{swift,kt} は RN Bridge 形式 (`ReactContextBaseJavaModule` / `RCT_EXPORT_MODULE`)。我々は Expo Module 形式 (`Module()` + `definition()` + `AsyncFunction`) に書き直す。

API surface (root-lens の TS 側 `nativeCryptoProvider.ts` から呼ばれている形と同じに):

```kotlin
class AesGcmModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AesGcm")
    AsyncFunction("encrypt") { (key: ByteArray, iv: ByteArray, plaintext: ByteArray, aad: ByteArray) -> ByteArray ... }
    AsyncFunction("decrypt") { (key: ByteArray, iv: ByteArray, ciphertext: ByteArray, aad: ByteArray) -> ByteArray ... }
  }
}
```

実装は `javax.crypto.Cipher` / iOS `CryptoKit` で薄く包む。root-lens のロジックそのまま流用。

## スコープ外 (後続タスク)

- **買取 atomic swap (§4)** → task 10
- **ライセンス NFT 発行コントラクト (§5)** → task 11+
- **TDM オプトアウト埋め込み / AI 企業向け公開ページ (§6)** → server side
- **重複排除 (§4.4)** → server side / 別タスク
- **iOS 実機検証** (本タスクは Android Pixel 10 のみ verify)
- **production Privy app id / TP gateway** (devnet / dev tenant のみ)

## 実装内容 (順序)

1. **依存追加**: `npx expo install` で `@privy-io/expo @privy-io/expo-native-extensions @solana/web3.js @title-protocol/sdk @noble/curves @noble/hashes @noble/ciphers expo-secure-store fast-text-encoding react-native-get-random-values bs58 buffer @ethersproject/shims`
2. **shim.ts** 移植 (root-lens から)
3. **`app/modules/aes-gcm/`** 新規 Expo Module (iOS Swift + Android Kotlin、`Module()` 定義)
4. **TS layer** 移植: `app/src/hooks/useAuth.ts`, `app/src/services/titleProtocol.ts`, `app/src/services/nativeCryptoProvider.ts`
5. **App.tsx** に PrivyProvider を注入
6. **screens 移植**: `RegistrationScreen.tsx` (login UI) + `PublishingScreen.tsx` (subset, TP 登録進捗)
7. **CaptureView** 統合: signMp4 後に TP 登録呼び出し
8. **Pixel 10 で end-to-end**: Privy login → 撮影 → C2PA sign → TP register → Solana tx 確認

## 検証

- Privy login 成功 (wallet address が表示される)
- 04 Collection Flow → fold-laundry → 撮影完了 → result 画面に Core NFT mint tx hash 表示
- Solana Explorer (devnet) で tx 確認
- sidecar JSON `trust.tp_tx_hash` / `trust.core_nft_mint` に記録される

## 完了条件

- [ ] 依存 11 パッケージ install
- [ ] shim.ts 配置
- [ ] AES-GCM Expo Module (iOS + Android) 動作
- [ ] PrivyProvider が App root に組み込まれている
- [ ] RegistrationScreen で login → embedded Solana wallet が created
- [ ] useAuth で wallet address 取得
- [ ] titleProtocol.ts + nativeCryptoProvider.ts 移植
- [ ] CaptureView finalize で TP 登録 → Core NFT mint
- [ ] sidecar に tx hash + content hash 記録
- [ ] `tsc --noEmit` pass / `expo-doctor` pass
- [ ] Pixel 10 で end-to-end OK + Solana Explorer (devnet) で tx 確認

## 参考

- [Privy Expo SDK docs](https://docs.privy.io/guide/expo)
- [Title Protocol SDK](https://www.npmjs.com/package/@title-protocol/sdk)
- [@solana/web3.js](https://solana-labs.github.io/solana-web3.js/)
