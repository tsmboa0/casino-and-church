# Testnet deploy

Nothing here creates an account or sends a transaction. Run it only after the four accounts exist and the admin account holds the NEAR that `seed.sh` attaches. The network is testnet. Do not point any of this at mainnet.

The installed CLI is near-cli-rs 0.31.1. Argument order matters. `sign-as` comes before `network-config` on a function call. `deploy` does not take `sign-as`: it signs with the key already saved for the contract account.

## Toolchain

- Rust 1.95 with the `wasm32-unknown-unknown` target. `contracts/realm/rust-toolchain.toml` pins it, and cargo only sees that file when run from inside `contracts/realm` or a child directory.
- Node 24 and pnpm 10.
- near-cli-rs 0.31.1 (`near --version`).

## Accounts

Replace `you` with the prefix. Every account is on testnet.

| Account | Role |
| --- | --- |
| `you.testnet` | Faucet parent. It only creates the four children. |
| `realm.you.testnet` | The contract. |
| `boss.you.testnet` | Dealer and owner agent (Don Fortuna). |
| `relayer.you.testnet` | Signs delegate transactions and pays gas. |
| `admin.you.testnet` | Seeds the pools. It must hold the NEAR being attached. |

Full demo, about 545 NEAR:

| Use | NEAR |
| --- | --- |
| Vault | 400 |
| Treasury | 30 |
| Jackpot | 25 |
| Relayer (account creation and gas) | 60 |
| Boss | 10 |
| Contract storage reserve | 20 |

If the faucet cannot supply that, seed a smaller first table instead: vault 20, treasury 2, jackpot 1. Give the admin account those 23 NEAR plus a little gas, the relayer 15, the boss 2, and the contract 10. If even that is tight, set `chip_yocto` to `1000000000000000000000` (`10^21`) in the init JSON and tell the design agent to set `CHIPS_PER_NEAR = 1000` in `rules.ts`. The chip counts in the UI stay the same; one chip becomes 0.001 NEAR.

## Create the accounts

Parent, from the faucet:

```bash
near account create-account sponsor-by-faucet-service you.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create
```

Children. The amount is one argument, including the space and the word NEAR:

```bash
near account create-account fund-myself realm.you.testnet '10 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as you.testnet \
  network-config testnet sign-with-keychain send
near account create-account fund-myself boss.you.testnet '10 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as you.testnet \
  network-config testnet sign-with-keychain send
near account create-account fund-myself relayer.you.testnet '60 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as you.testnet \
  network-config testnet sign-with-keychain send
near account create-account fund-myself admin.you.testnet '460 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as you.testnet \
  network-config testnet sign-with-keychain send
```

Shrink those amounts to the small table above if the faucet parent cannot fund them. The admin account pays the seed, so it needs the vault, treasury, and jackpot amounts, not a leftover 1 NEAR.

## Deploy and seed

```bash
NEAR_ACCOUNT_PREFIX=you ./scripts/deploy.sh
REALM_CONTRACT=realm.you.testnet ADMIN_ACCOUNT=admin.you.testnet ./scripts/seed.sh
```

The deploy init patch sets `luck_per_chip_milli` to 80, candle cooldown to 15 seconds, and Harmony cooldown to 120 seconds. 80 is the demo value. `packages/sim/report.json` runs 200,000 coin bets of 100 chips and then the wheel: the vault ends at −290,953 chips at 80 and +85,338 chips at 40. 40 is the value for anything that is not this demo.

A smaller first seed:

```bash
REALM_CONTRACT=realm.you.testnet ADMIN_ACCOUNT=admin.you.testnet \
  SEED_VAULT_NEAR=20 SEED_TREASURY_NEAR=2 SEED_JACKPOT_NEAR=1 ./scripts/seed.sh
```

`seed.sh` signs as `ADMIN_ACCOUNT`. The admin account must hold the attached NEAR. Seeding is admin-only.

## Keys

The relayer signs a delegate action to a guest account and also transfers NEAR. A function-call key cannot do that, so the eight relayer keys are full-access keys. The four dealer keys are function-call keys on the realm, limited to `reveal`, `commit_batch`, `blackjack_show`, `set_params`, and `grant_promo`. No allowance is set, so they spend the boss account balance rather than a capped key budget.

Print each secret and put it in `.env`. Do not paste secrets into chat. Repeat the relayer command eight times and the dealer command four times, then join the printed `ed25519:` secrets with commas.

```bash
near account add-key relayer.you.testnet grant-full-access \
  autogenerate-new-keypair print-to-terminal \
  network-config testnet sign-with-keychain send

near account add-key boss.you.testnet grant-function-call-access \
  --contract-account-id realm.you.testnet \
  --function-names reveal,commit_batch,blackjack_show,set_params,grant_promo \
  autogenerate-new-keypair print-to-terminal \
  network-config testnet sign-with-keychain send
```

`DEALER_ENC_KEY` is 64 hex characters of your own random data (`openssl rand -hex 32`). It encrypts the server seeds in Postgres. Losing it makes the committed seeds unrevealable.

## Database

Neon is the plan's free-tier database. A Supabase Postgres URI is accepted when it is the direct connection or the session pooler on port **5432**. Port 6543 (transaction mode) cannot take the dealer's advisory lock (`pg_try_advisory_lock(8675309)`), so the server would refuse to start the dealer. The URI must include `sslmode=require`. The server strips that parameter and turns certificate verification off, which is what node-pg needs for Neon and Supabase certificates. The server applies `apps/server/sql/001_init.sql` on startup, including the history columns, so the database only has to be empty and the role has to be able to create tables.

## Run

```bash
pnpm --filter server dev
```

One dealer process per contract. A second process fails the advisory lock and stays a relayer only.

Host the server on Fly.io or Railway. Host the client on Vercel or Cloudflare Pages with `VITE_BACKEND=chain`, `VITE_API_URL` pointing at the server, and `VITE_REALM_CONTRACT` set. `CLIENT_ORIGIN` on the server must be that client origin.

`DEALER_CONCURRENCY` defaults to the number of dealer keys (4). Raise it only if you add keys.

A load test from one machine needs `ACCOUNTS_PER_IP_DAY` above 20 (for example 30) and `RELAY_ACCOUNT_HOUR` left at 120 or raised. The production defaults stay 3 accounts per IP per day and 120 relays per account per hour. Do not raise them on the public server and leave them there.

## Proof

After the server is up, these are the checks that still need the live deployment:

- `GET /healthz` returns `ok: true`, `commits_available` at least 150, `relayer_balance` above 50 NEAR, and `block_height_lag` under 5.
- `pnpm exec tsx scripts/e2e.mjs` twice, back to back, with `REALM_CONTRACT` and `E2E_API` set. Each run writes `packages/sim/e2e-report.json`. Commit that file only after a real run. A skipped run does not write it.
- Optionally `LOAD=1 pnpm exec tsx scripts/load.mjs` for five minutes. It reports p50, p95, max settle time, nonce errors, quota rejections, timeouts, and vault drift.

`node scripts/e2e.mjs` and `node scripts/load.mjs` exit 0 with no secrets, which is what CI runs.
