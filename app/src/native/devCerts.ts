// v0.0.1 task 07: 開発用 C2PA self-signed cert chain + device 秘密鍵 (PEM)。
//
// ⚠️ デフォルトは空文字列 (= signing 無し)。署名を有効にするには:
//      scripts/gen-dev-certs.sh
//   を 1 度実行すると本ファイルが PEM 実値に書き換わる。
//
// ⚠️ 値が入った状態で本ファイルを commit してはならない (秘密鍵が漏れる)。
//   ローカルの編集が git status に出ないようにするには:
//      git update-index --skip-worktree app/src/native/devCerts.ts
//   を実行する (push 前に元に戻したい場合は --no-skip-worktree)。
//
// 値が空のままだと CaptureView は signMp4 を skip し unsigned mp4 を出力する
// (機能は動くが C2PA manifest 無し)。

export const DEV_CHAIN_PEM = '';
export const DEV_DEVICE_KEY_PEM = '';
