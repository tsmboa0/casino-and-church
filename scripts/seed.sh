#!/usr/bin/env bash
# Attach testnet NEAR to the house pools. Amounts are whole NEAR.
# Default budget: vault 400, treasury 30, jackpot 25. Never mainnet.
set -euo pipefail
REALM="${REALM_CONTRACT:?set REALM_CONTRACT}"
# Only the admin role can seed. That account must hold the NEAR being attached.
ADMIN="${ADMIN_ACCOUNT:?set ADMIN_ACCOUNT to the admin signer, for example admin.you.testnet}"
NETWORK="${NEAR_NETWORK:-testnet}"
VAULT="${SEED_VAULT_NEAR:-400}"
TREASURY="${SEED_TREASURY_NEAR:-30}"
JACKPOT="${SEED_JACKPOT_NEAR:-25}"

seed() {
  near contract call-function as-transaction "$REALM" "$1" json-args '{}' \
    prepaid-gas '40 Tgas' attached-deposit "$2 NEAR" \
    sign-as "$ADMIN" network-config "$NETWORK" sign-with-keychain send
}
seed seed_vault "$VAULT"
seed seed_treasury "$TREASURY"
seed seed_jackpot "$JACKPOT"

echo "Seeded $REALM with vault=$VAULT treasury=$TREASURY jackpot=$JACKPOT NEAR."
echo "The dealer process commits the first seeds when it starts. Do not commit seeds by hand unless the dealer is stopped."
