# AGENTS.md: testing The Casino & The Church

A guide for AI agents (Claude Code, Codex, browser agents) and anyone automating a test pass. Everything here works
on the live site and on a fresh clone.

- **Live game:** https://casino-and-church.vercel.app (NEAR **testnet**, play money)
- **Contract:** `realm.casinonchurch.testnet` ([explorer](https://testnet.nearblocks.io/address/realm.casinonchurch.testnet))
- **API server:** https://server-production-d070a910.up.railway.app (`/healthz` reports dealer, relayer, AI hosts and the BTC market keeper)
- **Machine-readable summary:** https://casino-and-church.vercel.app/llms.txt
- **Overview for judges** (what was built, and where each claim lives in code): [`AGENT_README.md`](AGENT_README.md)

---

## 1. The fastest paths

| You want to | Open |
|---|---|
| Try every panel offline (no account, nothing on chain) | `https://casino-and-church.vercel.app/?demo=1&agent=1` |
| Jump straight to one game in the demo | `.../?demo=1&agent=1&play=roulette` |
| Test the real on-chain game | `.../?agent=1`, then **CREATE ACCOUNT** (section 3) |
| Open a place once signed in | add `&play=<place>` (section 2) |

**URL parameters**

- `agent=1`: no tap-to-start screen, no backstory, no guided tours, no music. Onboarding is a plain form.
- `demo=1`: the offline demo on any build. It has 500 chips and the same rules, simulated in the browser, and a simulated BTC price.
- `play=<place>`: once in the world, go to that place and open it.

## 2. Moving around without the canvas

The world is a canvas, but **every panel is plain HTML** (buttons, inputs, text). You never need to click the canvas:

- **Places button:** the folded-map icon in the top-right HUD, `#btn-places`. It lists every location by realm, and a click goes there and opens it.
- **Escape** closes any panel. The red **X** (`[data-close]`) does too.
- **`window.cnc`:** a small test API in the page:

```js
cnc.state()        // { mode: 'chain'|'mock', signedIn, profile, realm, chips, luck, faith, testNear, panelOpen, panelTitle }
cnc.places()       // [{ id, kind, label, realm }, ...]  every location
cnc.go('roulette') // go there and open it (true if found)
cnc.close()        // close the open panel
```

**Place ids:** `cashier`, `slots-west`, `slots-east`, `wheel`, `market`, `blackjack`, `roulette`, `coinflip`, `dice`,
`plot-1` to `plot-3`, `monitor`, `npc-owner` (Don Fortuna), `harmony`, `board`, `altar`, `missions`, `candles`,
`offering`, `confessional`, `ledger`, `commission`, `npc-priest` (Father Nakamoto).

**Aliases:** `btc` = `market`, `don` = `npc-owner`, `priest` = `npc-priest`, `desk` = `commission`, `quests` = `missions`.

Panels are `#modal .gm[role=dialog]`, with the title in `.gm-title span`. Results appear in `#res[role=status]`
("YOU WIN!", "YOU LOSE", "BET RETURNED", plus a "VIEW ON EXPLORER" link to the transaction on the live game). Toasts
are in `#toasts[role=log]`.

## 3. A real account on testnet (live game)

1. Open `https://casino-and-church.vercel.app/?agent=1` and click **CREATE ACCOUNT**.
2. Enter a username (3 to 16 letters or numbers; the hint confirms when it is free) and a password of at least 10
   characters, typed twice. Then click **NEXT**.
   - A NEAR wallet is created in the browser and sealed with the password. The server stores only a hash and the
     locked copy; it never sees the password.
3. Pick a character, then **NEXT**. You are in the world. **30 welcome chips** arrive within a few seconds, paid on chain.
4. To sign in from another browser: **SIGN IN** with the same username and password. It is the same account and
   the same chips.

**Chips:** 1 chip = 0.01 NEAR. Casino bets are 10 chips each, so the welcome grant covers 3 bets. For more:
**Cashier**, then **GET FREE TEST NEAR** (0.5 test NEAR), then **BUY CHIPS** (it becomes 50 chips). **CASH OUT** sends
chips back to the wallet as NEAR.

Every bet is a gasless NEAR transaction (NEP-366 meta-transactions through our relayer). A bet settles in about 5 to 8
seconds. The dealer commits to its seed before your bet (commit-reveal), so outcomes are provably fair.

## 4. What to test, place by place

**Casino** (LUCK rises with every bet; FAITH slowly fades while you stay)

| Place | What to do |
|---|---|
| `cashier` | free test NEAR, deposit, cash out, bet history with explorer links |
| `slots-west`, `slots-east`, `coinflip`, `dice`, `roulette`, `blackjack` | pick a bet, then SPIN / FLIP / ROLL / DEAL |
| `wheel` | Wheel of Fortune, free to spin once LUCK reaches 100 |
| `market` | **BTC Exchange**: call BTC UP or DOWN for a one-minute round (1, 2, 5 or 10 chips, pays 1.9x). The lock and close prices come from the **OutLayer TEE oracle** inside the contract. The result arrives about 2 minutes after betting. The chart is TradingView's live BTC/USDT. |
| `monitor` | the House Monitor: vault, limits, Don Fortuna's live decisions |
| `npc-owner` | chat with **Don Fortuna**, an AI host on NEAR AI Cloud whose answers are signed |
| `plot-1` to `plot-3` | Founders' Row: own a slot machine (needs standing; shows the requirements) |

**Crossroads** (nothing fades here)

| Place | What to do |
|---|---|
| `harmony` | Harmony Wheel: needs LUCK 50 and FAITH 50 (2-minute cooldown) |
| `board` | The Word at the Crossroads: both AI hosts' decisions, with **VERIFY A REAL DECISION** (checks the model's signature and the on-chain anchor in the browser) |

**Church** (FAITH grows; LUCK slowly runs dry)

| Place | What to do |
|---|---|
| `offering` | tithe chips for FAITH; claim alms if you are broke |
| `candles` | light a candle (15-second cooldown on testnet) |
| `altar` | offer LUCK, receive FAITH |
| `missions` | Quest Board: built-in quests and live campaigns (social tasks are attested by the Church oracle) |
| `commission` | Commission Desk: create a campaign (needs FAITH 10; rewards are escrowed from your chips) |
| `confessional` | whisper a sin, choose a penance (offer LUCK or tithe chips), be absolved for FAITH |
| `ledger` | treasury and Father Nakamoto's decisions |
| `npc-priest` | chat with **Father Nakamoto** (AI host) |

**Settings** (gear icon, `#btn-menu`): READ THE BACKSTORY, the casino and church tours, sound, EXPORT MY KEY, SIGN OUT.

## 5. Verify it on chain

- Every result card links to its transaction on testnet.nearblocks.io.
- Contract views (any NEAR RPC, `call_function` on `realm.casinonchurch.testnet`): `get_player {account_id}`,
  `get_pools`, `get_params`, `get_bet_result {account_id, bet_id}`, `get_recent_results {account_id}`,
  `get_market {account_id?}`, `get_market_bets {epoch}`, `get_campaigns {account_id?}`, `get_plots`.
- AI host decisions: `GET /agent/feed`, and `GET /agent/decision/<id>/proof` for the signed model output; its hash is
  anchored on chain.
- Server health: `GET /healthz`, which includes `market.ticks` and `market.lastError` for the BTC keeper.

## 6. Run it from a clone

Requirements: Node 22+, pnpm 9+. Rust 1.95 is only needed for the contract tests (pinned in `contracts/realm/rust-toolchain.toml`).

```bash
pnpm install
pnpm dev                 # http://localhost:5173: the offline demo, ready to play
pnpm test                # shared + server + simulation + contract tests, and both typechecks
```

- **Art:** the original art comes from licensed packs that may not be redistributed, so it is not in the repository.
  `pnpm dev` and `pnpm build` draw **placeholder art** automatically (from `apps/client/art-skeleton.json`: sprite
  names and sizes only). The whole game runs and plays; it just looks plainer. A strip at the bottom says so. The
  real look is on the live site.
- **On-chain mode locally** needs the server's keys (`.env.local`; see `DEPLOY.md`). To test the real chain, use the live site.
- Local URLs take the same parameters: `http://localhost:5173/?agent=1&play=market`.

**Layout:** `apps/client` (Phaser 3 + TypeScript), `apps/server` (Fastify: relayer, dealer, BTC market keeper, AI
hosts, Church oracle, accounts), `contracts/realm` (Rust, near-sdk 5), `packages/shared` (protocol, rules, codecs),
`packages/sim` (economy simulation and test vectors).

## 7. Good to know

- **Use landscape.** On a phone held upright the game asks you to rotate.
- **Time-based features:** BTC rounds lock 60 seconds after the first bet and close a minute later; candles and
  Harmony have short cooldowns; the AI hosts decide every 10 minutes.
- **A stuck bet is never lost.** If the dealer is late, the game claims a timeout and pays a penalty to the player.
  BTC rounds with no price in time are voided and refunded.
- **Testnet only.** Chips have no real value.
