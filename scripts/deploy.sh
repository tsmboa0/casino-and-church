#!/usr/bin/env bash
# Deploy realm to NEAR testnet and print the env the server needs.
# Requires near-cli-rs (`near`), a funded signer, and NEAR_ACCOUNT_PREFIX.
# This does not touch mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."

PREFIX="${NEAR_ACCOUNT_PREFIX:?set NEAR_ACCOUNT_PREFIX, for example alice}"
NETWORK="${NEAR_NETWORK:-testnet}"
REALM="${REALM_CONTRACT:-realm.$PREFIX.testnet}"
BOSS="${DEALER_ACCOUNT:-boss.$PREFIX.testnet}"
RELAYER="${RELAYER_ACCOUNT:-relayer.$PREFIX.testnet}"
ADMIN="${ADMIN_ACCOUNT:-admin.$PREFIX.testnet}"
WASM="contracts/realm/target/wasm32-unknown-unknown/release/realm.wasm"

if ! command -v near >/dev/null; then
  echo "near-cli-rs is not installed. Build the wasm, then deploy with your signer:"
  echo "  (cd contracts/realm && cargo build --target wasm32-unknown-unknown --release)"
  echo "  near contract deploy $REALM use-file $WASM without-init-call network-config $NETWORK sign-with-keychain send"
  exit 1
fi

(cd contracts/realm && cargo build --target wasm32-unknown-unknown --release)
BYTES=$(wc -c < "$WASM" | tr -d ' ')
if [ "$BYTES" -ge 655360 ]; then
  echo "wasm is ${BYTES} bytes, over the 640 KB budget"
  exit 1
fi

INIT=$(cat <<EOF
{"admin":"$ADMIN","dealer":"$BOSS","agent":"$BOSS","chip_yocto":null,"patch":{"luck_per_chip_milli":80,"candle_cooldown_s":15,"harmony_cooldown_s":120,"max_bet_chips":10,"welcome_grant_chips":100,"allowed_wagers":[10]}}
EOF
)

near contract deploy "$REALM" use-file "$WASM" \
  with-init-call new json-args "$INIT" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-keychain send

echo
echo "REALM_CONTRACT=$REALM"
echo "DEALER_ACCOUNT=$BOSS"
echo "RELAYER_ACCOUNT=$RELAYER"
echo "ADMIN_ACCOUNT=$ADMIN"
echo "Next: fund the vault with scripts/seed.sh, add relayer access keys, and put the keys in .env."
echo "Demo cooldowns are candle=15s and harmony=120s. Production defaults are 86400."
