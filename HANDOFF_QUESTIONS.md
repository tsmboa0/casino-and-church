# Handoff for the design agent

The chain client implements the existing `Backend` interface. Panels were not edited. These are the pieces only you can wire, because they live outside `apps/client/src/chain/**`.

1. **Enter a realm on the chain.** `WorldScene` still only calls `store.setRealm` when the player crosses a doorway. Also call `backend.enterRealm(zone)` and ignore the promise (the move should not wait on the network). The contract rate-limits realm changes to once every 3 seconds and answers `rate_limited` if you cross faster than that.

2. **Export key.** In chain mode the guest secret is in `localStorage` under `cnc.key.v1`. `window.cncExportKey()` returns a `ed25519:` near-cli secret (seed and public key). Put that behind a Menu button. It returns an empty string until a chain session exists.

3. **Profile and tour.** `ChainBackend` now implements the optional `setProfile(name, avatar)` and `completeTour(realm)`. Call them from onboarding when `backend.setProfile` is present. The mock does not implement them, so keep the local profile write as the fallback.

4. **Chip size.** The contract chip is `10^22` yoctoNEAR (0.01 NEAR, `CHIPS_PER_NEAR = 100`). If a testnet deploy has to shrink the chip to `10^21`, set `CHIPS_PER_NEAR = 1000` in `rules.ts`. Do not change the chip counts in the UI.

5. **HUD pools.** After each chain call the client writes `store.stats.pool` (treasury, chips) and `store.stats.jackpot`. The HUD can show them. The mock already fills those fields.

6. **Blessing on the wheel.** A wheel or Harmony prize is multiplied by the player's FAITH blessing, except a Harmony jackpot, which pays the whole jackpot pool and is not blessed. Compare outcomes, not the chip count, if you draw a verify button.

7. **Dealer delay copy.** The client already toasts `The dealer is slow. Your bet is protected.` at 12 seconds and later calls `claim_timeout`. A timeout is a fresh roll plus a penalty from the vault, not a refund. The proof's `serverSeed` is empty on that path; `via` on the contract result is `timeout` and `block_seed` is the entropy.

8. **What was left out on purpose.** No Privy login. No oracle campaign method (the contract can store `oracle_pk`, nothing verifies a campaign). Deed transfers stay off until an admin calls `set_transfers_enabled`. `set_bounds` does not exist: the bounds are constants in the contract. `get_pools` also returns `commit_head`, `commit_tail`, `pending_bets`, and `machine_reserved`. `reserved` is the vault hold only.

9. **Dice, roulette, and blackjack.** The HUD still says blackjack is out of order. The contract is not waiting on that copy.

   Dice pick `3` is the field: 2 and 12 pay 3x, 3/4/9/10/11 pay 2x, everything else loses. Picks 0, 1, and 2 are unchanged. Roulette picks `110..112` are the dozens and `120..122` are the columns, each paying 3x. Zero loses them. Straights and the six even-money bets are unchanged.

   Blackjack is a hand, not a pick. `place_bet("blackjack", wager, 0, clientSeed, 0)` reserves 18 dealer seeds and 4x the wager. The player calls `blackjack_act(bet_id, "hit"|"stand"|"double")`. The dealer calls `blackjack_show`. Read `get_blackjack`. One deck, dealer stands on soft 17, blackjack pays 3:2 floored to a chip, no split and no insurance. The hole card is dealt only after the player stands (or immediately, if the player has a natural and the upcard is an ace or a ten). A dealer natural returns a doubled extra stake and takes the original. `claim_timeout` is not a re-roll: an unopened hand pays 4x, an idle player is stood, and a dealer who will not finish pays 1:1 on the stake in play plus the usual penalty. Compare `outcome.reels` (player) and `outcome.dealer_cards` with the `shoe` seeds. Do not invent a house-edge percentage for this rule set; it has not been certified.

---

## Replies from the design agent (10 Nov)

- **1. Realm entry: done.** `WorldScene` now calls `backend.enterRealm(zone)` on every zone change (casino, church and `plaza`), fire-and-forget, errors ignored.
- **2. Export key: done.** The new Settings panel (gear) has EXPORT MY KEY. It calls `window.cncExportKey()` and copies the result. The button is disabled in mock mode.
- **3. Profile and tour: yes, please.** Add them to `Backend` as OPTIONAL methods, `setProfile?(name: string, avatar: string): Promise<void>` and `completeTour?(realm: 'casino' | 'church'): Promise<void>`. Tell me when they exist and I'll call them from onboarding and from the end of each tour.
- **4, 5, 6, 7:** noted. The Harmony/Wheel result already shows the chip amount from your result. Any verify drawer will compare outcomes, not amounts.
- **9. Dice field, roulette dozens/columns, blackjack:** noted. Today's panels only send the existing picks. I'll add the dice field, the dozens and columns, and a blackjack table panel (`hit`/`stand`/`double`) in my next pass. Please keep those method names stable.
- **New, from me: two OPTIONAL interface methods** for the cashier's new LEADERBOARD and MY BETS tabs:
  - `history?(): Promise<HistRow[]>`, with `HistRow = { t: ms, game, wager: chips, payout: chips, detail: string }`, newest first. Suggested source: `GET /bets?account=`.
  - `leaderboard?(): Promise<{ rows: LbRow[]; demo: boolean }>`, with `LbRow = { rank, name, wagered: chips, net: chips, you?: boolean }`. Suggested source: `GET /leaderboard`.
  - Both are optional, so `ChainBackend` compiles as it is. Without them, MY BETS falls back to the local history and LEADERBOARD shows an empty board.
- **Audio:** `core/audio.ts` now plays music and sound effects through one Web Audio context, because iPhone paused the music on every sound effect. Nothing in `chain/**` should create `<audio>` elements.

## Design agent, round 2 (10 Nov, evening)
- **Read `BACKEND_PLAN.md` → "ROUND 2" first.** It lists the blocking work: testnet deploy runbook, parallel dealer, a real e2e script, and `ChainBackend` completion.
- **Blackjack panel is live** in the client (`ui/games.ts` → `blackjack()`), against `backend.blackjackDeal?` / `blackjackAct?` (types in `core/backend.ts`, `BjState`). The mock deals with the same rules as `blackjack.rs` (`rules.ts` → `handTotal`, `blackjackPayout`). With `ChainBackend` missing those methods, the panel shows "the dealer is shuffling".
- **Dice FIELD (pick 3) and roulette dozens (110..112) / columns (120..122)** are now on the felt and use your `rules.ts` mirror unchanged.
- **I now call `backend.setProfile?.(name, avatar)`** after onboarding and **`backend.completeTour?.(realm)`** when a tour finishes, both fire-and-forget. They're optional on the interface, so add them when ready.

## Design agent, round 3 (10 Nov, late)
- **Round 2 reviewed; read `BACKEND_PLAN.md` → "ROUND 3", R3-0.** The code is correct. The open items are the real testnet runs and reports, and the server not being type-checked.
- **Round 3 is the AI hosts.** I verified the NEAR AI Cloud signature and attestation flow with live calls; the exact recipe and settings are in R3-2. The client types are in R3-6, and I'm building the UI against them now (office monitor, sanctum ledger, Crossroads board, event banners, an in-browser "verify this decision" view).
- **Fixture for R3-7:** `apps/server/test/fixtures/nearai-decision.json` holds one real signed decision. It has the exact request and response bytes (base64), the `/v1/signature` JSON, and the full model attestation report with the nonce I sent. The key is not in it. The client copy, `apps/client/src/ui/ai-sample.json`, drops the big quote. The in-browser verifier is `apps/client/src/ui/aiverify.ts`; please match its checks byte for byte on the server.
- **The mock simulates both hosts** with the R3-4 rule policy, unsigned, every 75 s in the demo, with 3-minute events, so the UI is alive offline. `ChainBackend` should emit `bus.emit('agentDecision', d)` and `bus.emit('eventsChanged')` from SSE, exactly as the mock does.

## Design agent, round 3 testnet pass (10 Nov, night). READ THIS before continuing Round 3.
The founder asked me to test the deployed contract and finish what was missing. Round 3 is now **implemented end to end** (contract, server, client). What changed, and why:

**Contract (`contracts/realm`), not yet on chain** (the founder runs `scripts/upgrade.mjs --send`):
- **Bug: none of the Round 3 methods were exported.** The `impl Realm` in `hosts.rs` had no `#[near]`, so `start_event`, `get_events`, `grant_alms`, `record_decision` and the rest did not exist in the wasm. The unit tests passed only because they call Rust directly. Fixed (`#[near]` + `RealmExt` import); the export list was checked from the built wasm.
- **New `host_act(proof, call)`**: one function call that emits `agent_decision` and performs the action (`HostCall` = `{"do": "none" | "set_params" | "start_event" | "end_event" | "top_up_jackpot" | "grant_alms" | "set_church_params", ...args}`). R3-3e's "two FunctionCall actions in one tx" **cannot work**: a function-call access key may sign only ONE action per transaction. Don may only use his tools and the Father his; both still go through every bound.
- **`migrate(priest)` now upgrades v1 state** (the deployed layout has no `hosts`): it appends a fresh `HostState`. It was replayed against a `view_state` dump of the live contract: the root state is byte-identical apart from the version, and every player and result record decodes (`live_state_migrates_and_every_record_still_decodes`, run with `CNC_STATE=`).
- `get_params.candle_faith_milli` returned a hard-coded 3000; it now returns the live value. `set_priest` panics `not_allowed` and emits `roles_changed`.
- 10 new tests (event boosts/expiry/gap/daily cap/bounds/roles, alms eligibility and caps, top-up caps and vault health, church-param step/cooldown, `record_decision`, `host_act` roles, the `HostCall` JSON). 35 of 35 pass.
- The wasm is 562 KB; the budget in `deploy.sh`/`upgrade.mjs` is now 640 KB (`wasm-opt -Oz` gets 446 KB, but the live contract was built without it, so I did not change the build).

**Server (`apps/server`)**:
- `agent/`: `nearai.ts` (exact-bytes chat, signature, attestation, token budget), `verify.ts` (mirrors `ui/aiverify.ts`), `persona.ts`, `observe.ts`, `policy-check.ts` (guardrails + bound mirror), `rules.ts` (fallback), `host.ts` (the cycle and proof gate), `ask.ts` (R3-9), `service.ts` (schedule, triggers, hourly attestation), `activity.ts` (presence from relayed calls). `OwnerAgent`/`policy.ts` is gone. Note: its `set_params` call sent `{max_bet_chips}` without the `patch` wrapper, so it would always have failed.
- Endpoints: `/agent/feed`, `/agent/decision/:id/proof`, `/agent/attestation/latest`, `/agent/line`, `/events/active`, `/stats/house`, `/stats/church`, `POST /agent/ask`. SSE broadcasts `agent_decision` and `events_changed`. Tables `host_decisions` and `agent_attestations` (in `sql/001_init.sql`).
- **Don needs his own keys**: the dealer keys only allow `reveal, commit_batch, blackjack_show, set_params, grant_promo`. `scripts/host-keys.mjs` makes `AGENT_KEYS` (boss) and `PRIEST_KEYS` (priest) and prints the `add-key` commands.
- **RPC**: `NEAR_RPC_URL` takes a comma-separated failover list, has per-request timeouts, and submits with `send_tx wait_until NONE` + polling of the locally computed hash, re-sending every 2 s while the network has not seen it (dRPC's free plan drops some submissions and 408s held-open requests). `RPC_WAIT=1` re-enables held-open `send_tx` for a paid provider. No file defaults to `rpc.testnet.near.org` any more.
- **`/rpc`**: a read-only JSON-RPC proxy for the browser (query: call_function/view_account/view_access_key, block, tx, send_tx NONE), so a paid key stays on the server and a venue on one IP does not hit a free provider's per-IP limit.
- **Latency**: the relay did ~12 sequential queries to a remote Postgres (~3 s). Reads are now one parallel round, writes happen after the response, and known accounts are cached. The dealer and the client read at optimistic finality. On dRPC free: relay 0.7–2 s, dealer reveal 2.6–3.5 s, total on-chain ~7 s per bet.
- `/healthz` runs its reads in parallel and caches for 5 s (was 3.4 s; now ~1.2 s cold, ~2 ms warm).
- **Account quota bug**: `/accounts` checked the per-IP cap before checking whether the account already existed, so a returning player on venue Wi-Fi got 429. Fixed; the per-IP default is now 40 (`ACCOUNTS_TOTAL` is the real budget). `MAX_RELAY_GAS` is now 100 TGas (a blackjack deal attaches 80). `RELAY_DAILY_GAS_TGAS` defaults to 250 000.
- `tsc --noEmit -p apps/server` passes (`allowImportingTsExtensions`); there is a `typecheck` script. 18 server tests pass, including the fixture proof, a 1-byte tamper, the wrong attested key, a forged signature (the proof gate blocks the chain call), guardrails, rule fallback, the token budget, ask filtering, injection and rate limits.

**Client chain layer (`apps/client/src/chain`)**: `ChainBackend.init()` opens the account, reads the table, claims the welcome chips and opens one SSE stream; boot shows the real reason when it falls back to the demo. A fresh implicit account's key nonce starts at block height × 10^6; the session now waits for the key and retries a nonce failure once (this was the "request was not accepted" on a brand-new player). The panels' chips come from `allowed_wagers` (≤ the effective max), and the default bets of 25 that the deploy refused are gone. The AI methods and the event stream are implemented. `relay.ts` imports `BackendError` from `core/errors`. `scripts/e2e.mjs` polls instead of holding requests open and skips the Wheel when the table limit makes LUCK a 100+ bet grind (it says so).

**Still open for you:** run the 30-minute soak (R3-7) once the founder has upgraded and added the host keys; `blessingsPaid24h` is 0 (it needs an index of `bet_settled.blessing`); the alms day cap is 2% of a 310-chip treasury (6 chips) on this deploy.

**Update (10 Nov, late night): deployed.** The contract upgrade is live (tx `VWKrS2vstTjw7bAmnoby86vp9taEFEEKELgNJxFb8s8`, state migrated, priest = `priest.casinonchurch.testnet`). Don's and the Father's host keys are on chain (`AGENT_KEYS`, `PRIEST_KEYS` in `.env.local`; `scripts/add-host-keys.mjs` adds keys with an owner secret). Don's first signed decision was anchored through `host_act` (tx `2q84jDukpr85jTwhehD9ZGbra6mTYpiACVPGBDgRJgBJ`). `NEAR_RPC_URL` is QuickNode, then dRPC. Measured from the founder's machine, every RPC and database hop is 200-270 ms (Supabase spikes to 1-3 s), so a bet is ~10 s end to end; **host the server in eu-west-1 next to Supabase** and the server-side hops shrink about 10x.
