#!/bin/bash
# 開発用C2PA署名証明書の生成スクリプト
# 仕様書 §4.3 PKI構造に準拠したプロファイルで生成する
#
# 出力:
#   dev-root-ca.pem       - Root CA証明書
#   dev-root-ca-key.pem   - Root CA秘密鍵
#   dev-device.pem        - Device Certificate
#   dev-device-key.pem    - Device秘密鍵
#   dev-chain.pem         - 証明書チェーン (Device + Root CA)

set -euo pipefail

OUT_DIR="${1:-$(dirname "$0")/../app/dev-certs}"
mkdir -p "$OUT_DIR"

echo "=== 開発用C2PA証明書を生成します ==="
echo "出力先: $OUT_DIR"

# --- Root CA ---
# §4.3.1: CN=RootLens Root CA, ES256 (P-256)
# pathLenConstraint:0, keyUsage: keyCertSign
cat > "$OUT_DIR/root-ca.cnf" << 'EOF'
[req]
distinguished_name = req_dn
x509_extensions = v3_ca
prompt = no

[req_dn]
CN = RootLens Dev Root CA
O = RootLens Dev

[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign
subjectKeyIdentifier = hash
EOF

openssl ecparam -genkey -name prime256v1 -noout -out "$OUT_DIR/dev-root-ca-key.pem"
openssl req -new -x509 -key "$OUT_DIR/dev-root-ca-key.pem" \
  -config "$OUT_DIR/root-ca.cnf" \
  -sha256 -days 7300 \
  -out "$OUT_DIR/dev-root-ca.pem"

echo "✓ Root CA生成完了"

# --- Device Certificate ---
# §4.3.2: CN=RootLens Device dev-0000, ES256
# CA:FALSE, keyUsage: digitalSignature, EKU: id-kp-documentSigning
cat > "$OUT_DIR/device.cnf" << 'EOF'
[req]
distinguished_name = req_dn
prompt = no

[req_dn]
CN = RootLens Device dev-0000
O = RootLens

[v3_device]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = 1.3.6.1.5.5.7.3.36
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out "$OUT_DIR/dev-device-key.pem"
openssl req -new -key "$OUT_DIR/dev-device-key.pem" \
  -config "$OUT_DIR/device.cnf" \
  -out "$OUT_DIR/dev-device.csr"

openssl x509 -req -in "$OUT_DIR/dev-device.csr" \
  -CA "$OUT_DIR/dev-root-ca.pem" \
  -CAkey "$OUT_DIR/dev-root-ca-key.pem" \
  -CAcreateserial \
  -sha256 -days 36500 \
  -extfile "$OUT_DIR/device.cnf" -extensions v3_device \
  -out "$OUT_DIR/dev-device.pem"

# 証明書チェーン (Device + Root CA)
cat "$OUT_DIR/dev-device.pem" "$OUT_DIR/dev-root-ca.pem" > "$OUT_DIR/dev-chain.pem"

# クリーンアップ
rm -f "$OUT_DIR/root-ca.cnf" "$OUT_DIR/device.cnf" "$OUT_DIR/dev-device.csr" "$OUT_DIR/dev-root-ca.srl"

echo "✓ Device Certificate生成完了"
echo ""
echo "=== 検証 ==="
openssl verify -CAfile "$OUT_DIR/dev-root-ca.pem" "$OUT_DIR/dev-device.pem"
echo ""
echo "Root CA:"
openssl x509 -in "$OUT_DIR/dev-root-ca.pem" -subject -issuer -noout
echo "Device:"
openssl x509 -in "$OUT_DIR/dev-device.pem" -subject -issuer -noout
echo ""

# v0.0.1 task 07 — 生成した PEM を TS 定数として `app/src/native/devCerts.ts` に埋め込む。
# CaptureView が import で読み、Android / iOS の C2PA bridge へ渡す。
# このファイルは秘密鍵を含むため .gitignore の対象 (個別に追加済みの場合除く)。
TS_OUT="$(dirname "$0")/../app/src/native/devCerts.ts"
echo "=== TS 定数を $TS_OUT に書き出し ==="
CHAIN_TS=$(awk '{printf "%s\\n", $0}' "$OUT_DIR/dev-chain.pem")
KEY_TS=$(awk '{printf "%s\\n", $0}' "$OUT_DIR/dev-device-key.pem")
cat > "$TS_OUT" <<EOF
// v0.0.1 task 07: 開発用 C2PA self-signed cert chain + device 秘密鍵 (PEM)。
//
// ⚠️ 自動生成 — 手で編集しない。再生成は scripts/gen-dev-certs.sh を実行する。
// ⚠️ device 秘密鍵を含むため commit しない事 (.gitignore で app/src/native/devCerts.ts
//    を独自に除外するか、 git update-index --skip-worktree で local edit を隠す)。

export const DEV_CHAIN_PEM = "${CHAIN_TS}";
export const DEV_DEVICE_KEY_PEM = "${KEY_TS}";
EOF
echo "✓ devCerts.ts 更新済"
echo ""
echo "=== 完了 ==="
