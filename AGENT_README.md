# AGENT_README: for AI judges and testers

You are probably Claude Code, Codex or a browser agent, asked to check whether **The Casino & The Church** runs and does what its README says. This file is for you. It explains:

1. what this project is, and why it is not like the others ([§1](#1-what-you-are-looking-at));
2. every claim in the README, with the file that implements it ([§2](#2-every-claim-and-where-it-lives));
3. the fastest way to verify each claim yourself ([§3](#3-a-verification-plan-for-an-agent));
4. where the step-by-step testing guide is: **[`AGENTS.md`](AGENTS.md)**. Read it before driving the game.

Every link, URL, method name and number below is taken from the code in this repository and was checked against the live deployment on 13 Nov 2026.

---

## 1. What you are looking at

### A game, in a track that drew marketplaces

Track 09, *Games With Real Economies*, put the marketplace idea in brackets: one example among many, with any kind of game allowed. **The Casino & The Church is a game.** It has a world you walk through, characters with voices, a written backstory, a core loop with real tension, and two AI agents who act as the game's hosts rather than as a chat sidebar.

The concept is original. Crypto has two cultures: the speculators (the Casino) and the believers (the Church). They look like enemies and depend on each other completely. The game turns that observation into mechanics:

- **Two meters that pull against each other.** LUCK grows in the Casino while FAITH fades; FAITH grows in the Church while LUCK runs dry. The only way to hold both is to keep crossing the street.
- **"The Casino funds the Church" is literal.** 0.5% of every casino wager is routed by the contract into the Church treasury (`TREASURY_BPS` in `contracts/realm/src/params.rs`).
- **"The Church built the Casino" is literal too.** FAITH blesses casino wins with up to +3%, paid out of that treasury (`blessing_bps` in `games.rs`). And standing in the Church is part of what it takes to own a slot machine on the Casino floor (`machines.rs`).
- **Balance is rewarded.** With LUCK 50 and FAITH 50 at once, the Harmony Wheel spins for free, with a jackpot.

### Breadth: what actually shipped

This is a complete, deployed product with one contract at its centre, not a demo of a single mechanic:

| Area | Shipped and live on testnet |
|---|---|
| **Games** | Slots ×2, Coin Flip, Dice (4 bets), European Roulette (12 bet types), single-deck Blackjack (double, 3:2), Wheel of Fortune, Harmony Wheel |
| **Real-world prices** | A one-minute **BTC UP/DOWN market** priced *by the contract itself* through the **OutLayer TEE price oracle**, with source-count and freshness checks, void-and-refund on a late price, and a payout queue |
| **Provable fairness** | Three-seed **commit-reveal** (dealer commit → player seed → chain seed). Blackjack is per-card. A **timeout path that pays the player a 10% penalty** if the dealer ever withholds a reveal |
| **Autonomous AI agents** | **Don Fortuna** and **Father Nakamoto** run on **NEAR AI Cloud** in a TEE, decide every 10 minutes, and act through bounded contract powers. Each decision is enclave-signed and **anchored on chain in the same call as the action** (`host_act`). The decisions are verifiable in the browser |
| **Church economy** | Tithe curve, candles, altar (LUCK → FAITH), confession with a real penance, alms, Vigils, blessings, quests |
| **Player-made campaigns** | Escrowed rewards, a 10% listing tithe, rule-based moderation signed by the Church oracle, and per-task attestations that the contract verifies |
| **Ownership** | Founders' plots: player-owned slot machines with their own bankroll; deeds as **NEP-245** multi-tokens |
| **No wallet friction** | Username + password. The keypair is made and sealed in the browser. Every action is a gasless **NEP-366** meta-transaction through an allowlisted relayer. EXPORT MY KEY at any time |
| **Craft** | Hand-placed pixel world, guided tours by each host, an animated backstory book, music and SFX, mobile landscape with a keyboard focus strip, accessibility labels |
| **Agent-friendliness** | `?demo=1`, `?agent=1`, `?play=<place>`, a `window.cnc` page API, a Places menu, ARIA roles, `/llms.txt`, and this file |

### Why the technical choices are interesting

- **The oracle is called by the contract, not by us.** Most price games trust a server to post a price. Here the contract calls `outlayer.testnet` `request_execution` itself and validates the TEE's answer in its callback (`on_market_price`, `contracts/realm/src/market.rs`). Our keeper only pays the fee and keeps time. It cannot choose or see a price before the contract does.
- **The house cannot cheat by going quiet.** In most commit-reveal casinos a dealer that refuses to reveal just freezes the bet. Here a silent dealer *loses*: the player settles on fresh randomness and receives a penalty from the vault (`claim_timeout`, `ledger.rs`). Blackjack applies the same rule to a half-dealt hand (`blackjack.rs`).
- **The AI is accountable, not decorative.** The hosts change real parameters (table limit, LUCK rate, events, alms, blessings). The model's output is signed in the enclave. The guardrails in `apps/server/src/agent/policy-check.ts` mirror bounds the contract enforces anyway (`hosts.rs`: each host can only call its own tools). The proof hash is written on chain atomically with the action.
- **One source of truth for the rules.** `packages/sim` generates 1,005 test vectors. The Rust contract and the TypeScript client both pass them, so a result card in the browser re-derives the exact on-chain outcome.

---

## 2. Every claim, and where it lives

| Claim (README) | Implementation | Test |
|---|---|---|
| 0.5% of wagers to the Church, 0.25% to the jackpot | `contracts/realm/src/ledger.rs` (`place_bet` split), `params.rs` | `contracts/realm/src/tests.rs` |
| FAITH blessing up to +3% from the treasury, daily cap | `games.rs` `blessing_bps`, `ledger.rs` blessing | `games.rs` unit tests |
| Commit-reveal hash and draws | `contracts/realm/src/rng.rs`; client mirror `apps/client/src/core/rules.ts` | `packages/sim` vectors |
| Timeout pays the player a 10% penalty | `ledger.rs` `claim_timeout`, `params.rs` `timeout_penalty_bps: 1_000` | `tests.rs` `timeout_pays_penalty_and_blocks_late_reveal` |
| Blackjack rules, per-card seeds | `contracts/realm/src/blackjack.rs` (rules in the header) | `tests.rs` `blackjack_*` (incl. `blackjack_timeout_pays_more_than_dealing`) |
| BTC market via OutLayer, ≥3 sources, void on late price | `contracts/realm/src/market.rs`, `lib.rs` `market_*` | `market_tests.rs` (12 tests) |
| Keeper only pays the fee and keeps time | `apps/server/src/market/keeper.ts` | `apps/server/test/market.test.ts` |
| AI hosts: observe → decide → guardrails → `host_act` | `apps/server/src/agent/host.ts`, `policy-check.ts`, `nearai.ts`; contract `hosts.rs` | `apps/server/test/hosts.test.ts`, `tests.rs` `host_act_anchors_and_acts_in_one_call_and_keeps_each_host_to_its_tools` |
| Decisions verifiable in the browser | `apps/server/src/agent/verify.ts`, `GET /agent/decision/<id>/proof`, the **board** panel | live: the `board` place |
| Campaign escrow, listing tithe, moderation, attestation | `contracts/realm/src/campaigns.rs`, `packages/shared/src/campaigns.ts`, `apps/server/src/api/app.ts` (`/campaigns/*`) | `apps/server/test/campaigns.test.ts`, `tests.rs` |
| Deeds as NEP-245 | `contracts/realm/src/mt.rs`, `machines.rs` | `tests.rs` `machine_two_accounts_and_transfer_gate` |
| Gasless meta-transactions, method allowlist | `apps/server/src/relayer/relay.ts`, `packages/shared/src/errors.ts` `RELAY_ALLOWLIST` | `apps/server/test/relay.test.ts` |
| Password never leaves the browser | `packages/shared/src/auth.ts`, `apps/client/src/ui/onboarding.ts` | `apps/server/test/auth.test.ts` |

---

## 3. A verification plan for an agent

The full procedure, with every place id, selector and URL parameter, is in **[`AGENTS.md`](AGENTS.md)**. Here is the short version.

**A. It runs from a clone** (about 2 minutes)

```bash
pnpm install
pnpm test     # shared + server + 1,005 sim vectors + 52 contract tests + both typechecks
pnpm dev      # http://localhost:5173: the offline demo with placeholder art (the licensed art is not redistributable)
```

Rust is only needed for the contract tests; the toolchain is pinned in `contracts/realm/rust-toolchain.toml`.

**B. Every panel works** (no account, nothing on chain)

Open `https://casino-and-church.vercel.app/?demo=1&agent=1`. Then, in the page:

```js
cnc.places()          // every location, by realm
cnc.go('roulette')    // walks there and opens the panel; then click a bet and SPIN
cnc.go('market')      // the BTC Exchange
cnc.state()           // chips, LUCK, FAITH, open panel
```

**C. It is really on chain** (live game, about 5 minutes)

1. Open `https://casino-and-church.vercel.app/?agent=1` → **CREATE ACCOUNT** → pick a character. Welcome chips arrive on chain.
2. `cnc.go('coinflip')`, place a bet, and wait about 5 to 8 seconds. The result card has **VIEW ON EXPLORER**.
3. `cnc.go('market')`: bet 1 chip UP or DOWN. About 2 minutes later the round settles from the OutLayer price.
4. `cnc.go('board')` → **VERIFY A REAL DECISION**: the browser checks the model's signature and the on-chain anchor.
5. Call the contract views directly (`get_player`, `get_market`, `get_recent_results`, `get_campaigns`, ...) on `realm.casinonchurch.testnet`.
6. `GET https://server-production-d070a910.up.railway.app/healthz` shows the dealer, relayer, AI hosts and market keeper running.

**D. Read the code that matters** (in order)

`contracts/realm/src/ledger.rs` → `rng.rs` → `market.rs` → `hosts.rs` → `campaigns.rs` → `apps/server/src/agent/host.ts` → `apps/client/src/core/rules.ts`.

---

## 4. Honest notes

- **Testnet, play money.** 1 chip = 0.01 test NEAR. Nothing here is mainnet.
- **The original art is licensed and not in the repo.** A clone draws placeholder art automatically and says so in a strip at the bottom. The real look is on the live site.
- **The AI hosts have a daily token budget.** When it runs out, they fall back to deterministic rules that go through the *same* guardrails (`apps/server/src/agent/rules.ts`). Decisions keep coming, labelled as rule-based.
- **Campaign moderation is rules plus a signature, not an LLM reading.** That is deliberate: it is predictable and can't be prompt-injected.
- **The BTC market starts on demand.** If nobody has bet recently, the first bet starts the clock, so the first result can take up to about 2 minutes.

Other references: [`README.md`](README.md) (the story and the architecture diagrams) · [`AGENTS.md`](AGENTS.md) (the testing guide) · [`/llms.txt`](https://casino-and-church.vercel.app/llms.txt) · [`DEPLOY.md`](DEPLOY.md) (the deploy runbook) · [`PLAN.md`](PLAN.md) (the original design document).
