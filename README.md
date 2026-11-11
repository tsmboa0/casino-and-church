# The Casino & The Church

A 2D pixel-art RPG for mobile landscape, built on NEAR (testnet). See `PLAN.md` for the full design.

## Run the client

```bash
pnpm install
pnpm assets        # builds atlases from assets/vendor (licensed packs, git-ignored)
pnpm dev           # http://localhost:5173
```

The licensed art packs are **not** in the repository. Put the unzipped packs in `assets/vendor/casino-16` and `assets/vendor/medieval-16`, then run `pnpm assets`.

### Debug URL parameters

| Param | Effect |
|---|---|
| `?skip=1` | Skip onboarding (add `&realm=church`, `&avatar=m_bard`, `&name=Ana`, `&tour=1` to run the tour) |
| `?cam=x,y&zoom=1` | Park the camera at a world position (no player) |

Keyboard: arrows/WASD move, `Z`/`Enter` interact, `X`/`Esc` back (hold to run), `C` menu, `V` action.

## What is real, and what is still the mock

The game boots on the **mock**. Nothing is on mainnet. A testnet contract and a relayer exist in this repo, and the client uses them only when `VITE_BACKEND=chain` and `GET /healthz` succeeds. If that check fails, the client toasts "Offline demo mode" and keeps the mock, so a dead server never leaves a blank screen.

On chain, chips, bets, the church (tithe, altar, candle, quests), the wheel, Harmony, and plot deeds are the `realm` contract. The dealer reveals from committed seeds. If the dealer is late, the client waits, then calls `claim_timeout`. That path is a **new roll plus a penalty paid from the vault**, not a refund of the stake. The dealer's seed is hidden until reveal, so a withheld win is not paid at the original roll. `proof.serverSeed` is empty on a timeout; recompute with `client_seed || chain_seed || block_seed || bet_id || "timeout"`.

Not shipped: Privy login, oracle campaigns, and deed transfers (they stay disabled until an admin enables them). Guest keys live in the browser. The owner agent can lower the table limit from vault numbers and, if `ANTHROPIC_API_KEY` is set, phrase one line. It never reads player text and never sends a transaction the policy did not already choose.

`luck_per_chip_milli` is **80** on the testnet deploy so a judge can fill the LUCK meter in one session. `packages/sim/report.json` runs 200,000 coin bets of 100 chips, then the wheel whenever LUCK hits 100. At 80 the vault finishes at **−290,953 chips**. At 40 it finishes at **+85,338 chips**. Use 40 for any deployment that is not the demo.

## Run the server

```bash
cp .env.example .env          # fill accounts and keys before chain mode
pnpm install
pnpm server                   # http://localhost:8787  (memory store if DATABASE_URL is empty)
```

The dealer refuses to start against a live contract unless `DATABASE_URL` is set. Without a contract, `/healthz` returns `ok: false` and the client stays on the mock.

```bash
pnpm test:backend             # codec, relayer rejects, TS vectors, RTP sim
(cd contracts/realm && cargo test)
```

## Deploy (testnet only)

The full runbook, including the near-cli-rs 0.31.1 commands, the funding numbers, and the key layout, is `DEPLOY.md`. Do not run it until the four accounts exist and `admin.<prefix>.testnet` holds the seed.

```bash
NEAR_ACCOUNT_PREFIX=you ./scripts/deploy.sh
REALM_CONTRACT=realm.you.testnet ADMIN_ACCOUNT=admin.you.testnet \
  SEED_VAULT_NEAR=20 SEED_TREASURY_NEAR=2 SEED_JACKPOT_NEAR=1 ./scripts/seed.sh
```

`deploy.sh` sets `luck_per_chip_milli` to 80 and the demo cooldowns (candle 15s, Harmony 120s). Then put the relayer and dealer keys in `.env` and start the server. The dealer commits the first seeds itself.

`scripts/e2e.mjs` exits 0 when `REALM_CONTRACT` and `E2E_API` are unset. `scripts/load.mjs` exits 0 unless `LOAD=1`.

## Check a bet

Take `server_seed`, `client_seed`, and `chain_seed` from the result (64 hex chars each). The reveal hash is SHA-256 of those three 32-byte values followed by the bet id as a little-endian u64. The first 32 bits, times the table size, shifted down by 32, pick the outcome. The same functions are in `apps/client/src/core/rules.ts`. A mismatch throws "Result mismatch, please report this bet".

## Two-minute demo

1. Open the client. Skip onboarding with `?skip=1`. The mock already has chips.
2. Spin the slots, flip the coin, tithe 10 chips at the offering box. The HUD moves.
3. For the chain: fund a relayer, set `VITE_BACKEND=chain`, reload. A guest account is created on the first action. Use the cashier faucet, deposit, then spin. The HUD snaps to the contract after the reveal.
4. Stop the dealer and spin once. After the timeout window the bet still settles, with the penalty, and the toast says the bet is protected.

## Layout

```
apps/client      Vite + Phaser 3 + TypeScript game client
apps/server      relayer, dealer, faucet, owner agent
contracts/realm  the NEAR contract
packages/shared  delegate-action codec
packages/sim     RTP and solvency
scripts/         asset pipeline, deploy, seed
assets/vendor/   third-party packs (git-ignored; licence forbids sharing)
PLAN.md          master plan
BACKEND_PLAN.md  contract and server plan
```

Art: Jephed, Game Between The Lines, https://gamebetweenthelines.com/
