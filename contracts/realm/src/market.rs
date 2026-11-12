//! BTC UP/DOWN market: one-minute rounds priced by an OutLayer TEE worker.
//!
//! Rounds run back to back. While round N is OPEN players bet UP or DOWN; at its scheduled lock time the dealer
//! calls `market_tick`, which asks OutLayer (a TEE that reads BTC from several exchanges and returns the median)
//! for one fresh price. That single price closes round N-1 (its close price) and locks round N (its lock price),
//! and round N+1 opens. A round is UP if close > lock, DOWN if close < lock; an exact tie refunds everyone.
//!
//! Bets are fixed odds against the house vault (`payout_bps`, 1.9x by default), each reserved in `reserved` when
//! placed exactly like the other house games. Payouts go through a small queue settled by the price callback and
//! `market_settle` (anyone may call it), so a busy round never needs one oversized transaction.
//!
//! Fairness:
//! - bets close at the round's scheduled lock time, before the price that locks it is even requested;
//! - only the dealer may request the price, and only within `grace_s` of the scheduled lock, so nobody can wait
//!   for a favourable moment; after that anyone can call `market_tick` and both unpriced rounds are voided (refunds);
//! - the price must come back from the configured OutLayer account through this contract's own callback, carry
//!   the configured token, at least 3 exchange sources, and an exchange timestamp close to the request.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, AccountId, Gas, NearToken, Promise};

use crate::events::emit;
use crate::games::{blessing_bps, GameKind};
use crate::params::{JACKPOT_BPS, TREASURY_BPS};
use crate::player::{add_luck, StoredResult};
use crate::util::{apply_bps, must, whole_chips};
use crate::Realm;

const SEC: u64 = 1_000_000_000;
/// an oracle request that never called back (it always does; this is belt and braces) stops blocking after this
const PENDING_STALE_NS: u64 = 300 * SEC;
/// bets paid inside the price callback; the rest wait for `market_settle`
const SETTLE_IN_CALLBACK: u32 = 10;
/// rounds older than this many epochs are deleted once settled
const KEEP_ROUNDS: u64 = 60;

pub const UP: u8 = 1;
pub const DOWN: u8 = 2;

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Phase {
    Open,
    Live,
    Closed,
    Void,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Round {
    pub epoch: u64,
    pub phase: Phase,
    pub open_ns: u64,
    /// betting closes here; the price that locks the round is requested after it
    pub lock_ns: u64,
    pub locked_at_ns: u64,
    pub closed_at_ns: u64,
    /// US cents; 0 = none
    pub lock_price: u64,
    pub close_price: u64,
    /// exchange timestamps (seconds) reported by the oracle
    pub lock_ts: u64,
    pub close_ts: u64,
    pub up: u128,
    pub down: u128,
    pub bets: u32,
    pub settled: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct MarketBet {
    pub bet_id: u64,
    pub player: AccountId,
    pub side: u8,
    pub wager: u128,
    pub hold: u128,
    pub blessing_bps: u16,
}

#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct MarketState {
    pub enabled: bool,
    /// the round taking bets (0 = the market never started)
    pub epoch: u64,
    pub rounds: LookupMap<u64, Round>,
    /// "epoch:index"
    pub bets: LookupMap<String, MarketBet>,
    /// "epoch:account" -> index (one bet per player per round)
    pub mine: LookupMap<String, u32>,
    /// closed or void rounds that still have unpaid bets, oldest first
    pub queue: Vec<u64>,
    pub pending_epoch: u64,
    pub pending_ns: u64,
    pub outlayer: AccountId,
    /// JSON for OutLayer's `source` (a project, or a WasmUrl pinned by hash)
    pub source: String,
    pub token: String,
    pub payout_bps: u32,
    pub round_s: u64,
    pub grace_s: u64,
    /// attached to each price request; OutLayer refunds what it does not charge to the payer (the dealer)
    pub fee: u128,
    pub wagers: Vec<u32>,
    pub last_price: u64,
    pub last_price_ns: u64,
    pub requests: u64,
    pub failures: u64,
    /// may request prices besides the dealer and the admin: a small account that pays the OutLayer fee, so oracle
    /// costs never come out of the player vault (the dealer's keys are function-call keys and cannot attach NEAR)
    pub keeper: Option<AccountId>,
}

impl MarketState {
    pub fn new() -> Self {
        Self {
            enabled: false,
            epoch: 0,
            rounds: LookupMap::new(b"xr".to_vec()),
            bets: LookupMap::new(b"xb".to_vec()),
            mine: LookupMap::new(b"xm".to_vec()),
            queue: Vec::new(),
            pending_epoch: 0,
            pending_ns: 0,
            outlayer: "outlayer.testnet".parse().unwrap(),
            source: r#"{"Project":{"project_id":"zavodil2.testnet/price-oracle"}}"#.into(),
            token: "nbtc.bridge.near".into(),
            payout_bps: 19_000,
            round_s: 60,
            grace_s: 45,
            fee: 20_000_000_000_000_000_000_000, // 0.02 NEAR; about 0.0014 is charged, the rest refunded
            wagers: vec![1, 2, 5, 10],
            last_price: 0,
            last_price_ns: 0,
            requests: 0,
            failures: 0,
            keeper: None,
        }
    }
}

// ------------------------------------------------------------------ JSON

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct OracleOut {
    success: bool,
    #[serde(default)]
    prices: Vec<OraclePrice>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct OraclePrice {
    token: String,
    price: f64,
    timestamp: u64,
    #[serde(default)]
    sources: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(crate = "near_sdk::serde", default)]
pub struct MarketConfig {
    pub enabled: Option<bool>,
    pub outlayer: Option<AccountId>,
    pub source: Option<String>,
    pub token: Option<String>,
    pub payout_bps: Option<u32>,
    pub round_s: Option<u64>,
    pub grace_s: Option<u64>,
    pub fee: Option<U128>,
    pub wagers: Option<Vec<u32>>,
    /// "" removes the keeper
    pub keeper: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoundView {
    pub epoch: u64,
    pub phase: String,
    pub open_ns: U64,
    pub lock_ns: U64,
    pub locked_at_ns: U64,
    pub closed_at_ns: U64,
    pub lock_price: u64,
    pub close_price: u64,
    pub up: U128,
    pub down: U128,
    pub bets: u32,
    /// "up" | "down" | "tie" | "void" | "" (not decided yet, or no price because nobody bet)
    pub outcome: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MyMarketBet {
    pub epoch: u64,
    pub bet_id: u64,
    pub side: String,
    pub wager: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoundBetView {
    pub bet_id: u64,
    pub player: AccountId,
    pub side: String,
    pub wager: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MarketView {
    pub enabled: bool,
    pub now_ns: U64,
    pub epoch: u64,
    pub pending: bool,
    pub round_s: u64,
    pub grace_s: u64,
    pub payout_bps: u32,
    pub wagers: Vec<u32>,
    pub fee: U128,
    pub token: String,
    pub outlayer: AccountId,
    pub source: String,
    pub open: Option<RoundView>,
    pub live: Option<RoundView>,
    /// most recent first
    pub recent: Vec<RoundView>,
    /// the viewer's bets in the open and live rounds (settled ones are in get_recent_results)
    pub mine: Vec<MyMarketBet>,
    pub last_price: u64,
    pub last_price_ns: U64,
    pub queue: u32,
    /// true when the dealer should call market_tick now (a priced tick), or anyone may (a void)
    pub due: bool,
    pub requests: u64,
    pub failures: u64,
    pub keeper: Option<AccountId>,
}

fn side_str(side: u8) -> &'static str {
    if side == UP { "up" } else { "down" }
}

fn outcome_of(r: &Round) -> &'static str {
    match r.phase {
        Phase::Void => "void",
        Phase::Closed if r.lock_price == 0 || r.close_price == 0 => "",
        Phase::Closed if r.close_price > r.lock_price => "up",
        Phase::Closed if r.close_price < r.lock_price => "down",
        Phase::Closed => "tie",
        _ => "",
    }
}

fn round_view(r: &Round) -> RoundView {
    RoundView {
        epoch: r.epoch,
        phase: match r.phase { Phase::Open => "open", Phase::Live => "live", Phase::Closed => "closed", Phase::Void => "void" }.into(),
        open_ns: U64(r.open_ns),
        lock_ns: U64(r.lock_ns),
        locked_at_ns: U64(r.locked_at_ns),
        closed_at_ns: U64(r.closed_at_ns),
        lock_price: r.lock_price,
        close_price: r.close_price,
        up: U128(r.up),
        down: U128(r.down),
        bets: r.bets,
        outcome: outcome_of(r).into(),
    }
}

fn cents_str(c: u64) -> String {
    format!("{}.{:02}", c / 100, c % 100)
}

fn bet_key(epoch: u64, idx: u32) -> String {
    format!("{epoch}:{idx}")
}

fn mine_key(epoch: u64, who: &AccountId) -> String {
    format!("{epoch}:{who}")
}

/// Parse and check an OutLayer reply. Returns (price in cents, exchange timestamp in seconds).
pub(crate) fn parse_oracle(raw: &[u8], token: &str, requested_ns: u64) -> Result<(u64, u64), &'static str> {
    let out: OracleOut = near_sdk::serde_json::from_slice(raw).map_err(|_| "oracle_bad_json")?;
    if !out.success {
        return Err("oracle_failed");
    }
    let p = out.prices.iter().find(|p| p.token == token).ok_or("oracle_no_token")?;
    if !(p.price.is_finite() && p.price > 0.0 && p.price < 1e12) {
        return Err("oracle_bad_price");
    }
    if p.sources.len() < 3 {
        return Err("oracle_few_sources");
    }
    let req_s = requested_ns / SEC;
    // the exchange data must be from around the request: not older than 15 s before it, not later than 3 min after
    if p.timestamp + 15 < req_s || p.timestamp > req_s + 180 {
        return Err("oracle_stale");
    }
    let cents = (p.price * 100.0).round() as u64;
    if cents == 0 {
        return Err("oracle_bad_price");
    }
    Ok((cents, p.timestamp))
}

impl Realm {
    fn market_round(&self, epoch: u64) -> Option<Round> {
        self.market.rounds.get(&epoch).cloned()
    }

    fn new_round(&mut self, epoch: u64, now: u64) {
        let r = Round {
            epoch,
            phase: Phase::Open,
            open_ns: now,
            lock_ns: now + self.market.round_s * SEC,
            locked_at_ns: 0,
            closed_at_ns: 0,
            lock_price: 0,
            close_price: 0,
            lock_ts: 0,
            close_ts: 0,
            up: 0,
            down: 0,
            bets: 0,
            settled: 0,
        };
        self.market.rounds.insert(epoch, r);
        self.market.epoch = epoch;
        // forget old, fully paid rounds
        if epoch > KEEP_ROUNDS {
            let old = epoch - KEEP_ROUNDS;
            if !self.market.queue.contains(&old) {
                self.market.rounds.remove(&old);
            }
        }
        emit("market_round", near_sdk::serde_json::json!({ "epoch": epoch, "phase": "open", "lock_ns": (now + self.market.round_s * SEC).to_string() }));
    }

    /// the round before the open one, if it is still live
    fn live_round(&self) -> Option<Round> {
        if self.market.epoch < 2 {
            return None;
        }
        self.market_round(self.market.epoch - 1).filter(|r| r.phase == Phase::Live)
    }

    fn finish_round(&mut self, mut r: Round, phase: Phase, now: u64) {
        r.phase = phase;
        r.closed_at_ns = now;
        if r.bets > r.settled && !self.market.queue.contains(&r.epoch) {
            self.market.queue.push(r.epoch);
        }
        emit("market_round", near_sdk::serde_json::json!({
            "epoch": r.epoch, "phase": if phase == Phase::Void { "void" } else { "closed" },
            "lock_price": r.lock_price, "close_price": r.close_price, "outcome": outcome_of(&r), "bets": r.bets,
        }));
        self.market.rounds.insert(r.epoch, r);
    }

    // ------------------------------------------------------------------ admin

    pub(crate) fn market_configure_inner(&mut self, c: MarketConfig) {
        self.assert_admin();
        let m = &mut self.market;
        if let Some(v) = c.outlayer { m.outlayer = v; }
        if let Some(v) = c.source {
            must(near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&v).map(|j| j.is_object()).unwrap_or(false), "bad_args");
            m.source = v;
        }
        if let Some(v) = c.token { must(!v.is_empty() && v.len() <= 64, "bad_args"); m.token = v; }
        if let Some(v) = c.payout_bps { must((10_000..=19_800).contains(&v), "bad_args"); m.payout_bps = v; }
        if let Some(v) = c.round_s { must((30..=900).contains(&v), "bad_args"); m.round_s = v; }
        if let Some(v) = c.grace_s { must((15..=300).contains(&v), "bad_args"); m.grace_s = v; }
        if let Some(v) = c.fee { must(v.0 <= 1_000_000_000_000_000_000_000_000, "bad_args"); m.fee = v.0; }
        if let Some(v) = c.wagers { must(!v.is_empty() && v.len() <= 8 && v.iter().all(|w| *w >= 1), "bad_args"); m.wagers = v; }
        if let Some(v) = c.keeper {
            m.keeper = if v.is_empty() { None } else { Some(v.parse().unwrap_or_else(|_| env::panic_str("bad_args"))) };
        }
        if let Some(v) = c.enabled { m.enabled = v; }
        emit("market_config", near_sdk::serde_json::json!({ "enabled": self.market.enabled, "payout_bps": self.market.payout_bps, "round_s": self.market.round_s }));
    }

    // ------------------------------------------------------------------ bets

    pub(crate) fn market_bet_inner(&mut self, epoch: u64, side: u8, wager: u128) -> u64 {
        self.assert_running();
        must(self.market.enabled, "market_closed");
        must(side == UP || side == DOWN, "bad_pick");
        let now = env::block_timestamp();
        if self.market.epoch == 0 {
            self.new_round(1, now);
        }
        must(epoch == self.market.epoch, "round_moved");
        let mut open = self.market_round(epoch).expect("round");
        if now >= open.lock_ns {
            // an idle market: nobody bet in this window and nothing is live, so the first bet starts a fresh one
            let live = self.live_round();
            let busy = open.bets > 0 || live.as_ref().map(|r| r.bets > 0).unwrap_or(false) || self.market.pending_epoch != 0;
            must(!busy, "round_locked");
            if let Some(l) = live {
                self.finish_round(l, Phase::Closed, now);
            }
            open.open_ns = now;
            open.lock_ns = now + self.market.round_s * SEC;
        }

        let chip = self.params.chip_yocto;
        let chips = whole_chips(wager, chip);
        must(wager == chips * chip && chips >= 1 && chips <= u128::from(u32::MAX), "bad_wager");
        must(self.market.wagers.contains(&(chips as u32)), "bad_wager");
        let free_chips = whole_chips(self.vault.saturating_sub(self.reserved), chip);
        must(chips <= u128::from(self.params.max_bet_chips) && chips <= free_chips / 200, "max_bet");

        let id = env::predecessor_account_id();
        let mk = mine_key(epoch, &id);
        must(self.market.mine.get(&mk).is_none(), "already_bet");
        let (mut player, is_new) = self.touch(&id);
        must(player.chips >= wager, "no_chips");
        let hold = apply_bps(wager, u128::from(self.market.payout_bps));
        must(self.vault + wager >= self.reserved + hold, "vault_low");
        self.debit(&mut player, wager);
        self.vault += wager;
        self.reserved += hold;

        let bet_id = self.next_bet_id;
        self.next_bet_id += 1;
        let idx = open.bets;
        self.market.bets.insert(bet_key(epoch, idx), MarketBet {
            bet_id,
            player: id.clone(),
            side,
            wager,
            hold,
            blessing_bps: blessing_bps(player.faith_milli),
        });
        self.market.mine.insert(mk, idx);
        open.bets += 1;
        if side == UP { open.up += wager } else { open.down += wager }
        let lock_ns = open.lock_ns;
        self.market.rounds.insert(epoch, open);
        self.save(id.clone(), player, is_new);
        emit("market_bet", near_sdk::serde_json::json!({
            "account_id": id.to_string(), "bet_id": bet_id.to_string(), "epoch": epoch,
            "side": side_str(side), "wager": wager.to_string(), "lock_ns": lock_ns.to_string(),
        }));
        bet_id
    }

    // ------------------------------------------------------------------ rounds

    /// Moves the market on at a round's lock time. Returns the price request when one is made.
    pub(crate) fn market_tick_inner(&mut self) -> Option<Promise> {
        self.assert_running();
        must(self.market.enabled, "market_closed");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        must(self.market.epoch > 0, "nothing_due");
        let busy = self.market.pending_epoch != 0 && now < self.market.pending_ns + PENDING_STALE_NS;
        must(!busy, "market_busy");
        let open = self.market_round(self.market.epoch).expect("round");
        must(now >= open.lock_ns, "too_early");
        let live = self.live_round();
        let need = open.bets > 0 || live.as_ref().map(|r| r.bets > 0).unwrap_or(false);
        must(need, "nothing_due");

        if now > open.lock_ns + self.market.grace_s * SEC {
            // the price was not taken in time: void both unpriced rounds (everyone is refunded) and start again
            if let Some(l) = live {
                self.finish_round(l, Phase::Void, now);
            }
            let next = open.epoch + 1;
            self.finish_round(open, Phase::Void, now);
            self.new_round(next, now);
            self.market.pending_epoch = 0;
            self.settle_market(SETTLE_IN_CALLBACK);
            if deposit > 0 {
                Promise::new(caller).transfer(NearToken::from_yoctonear(deposit)).detach();
            }
            return None;
        }

        let keeper = self.market.keeper.as_ref() == Some(&caller);
        must(caller == self.roles.dealer || caller == self.roles.admin || keeper, "not_allowed");
        must(deposit >= self.market.fee, "bad_args");
        self.market.pending_epoch = open.epoch;
        self.market.pending_ns = now;
        self.market.requests += 1;
        let input = format!(r#"{{"command":"get_prices","max_age_secs":5,"tokens":["{}"]}}"#, self.market.token);
        let args = format!(
            r#"{{"source":{},"resource_limits":{{"max_instructions":10000000000,"max_memory_mb":128,"max_execution_seconds":60}},"input_data":{},"response_format":"Json","payer_account_id":"{}","params":null}}"#,
            self.market.source,
            near_sdk::serde_json::to_string(&input).unwrap(),
            env::signer_account_id(),
        );
        emit("market_price_requested", near_sdk::serde_json::json!({ "epoch": open.epoch, "requested_ns": now.to_string() }));
        Some(
            Promise::new(self.market.outlayer.clone())
                .function_call("request_execution".to_string(), args.into_bytes(), NearToken::from_yoctonear(deposit), Gas::from_tgas(90))
                .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(80)).on_market_price(open.epoch, U64(now))),
        )
    }

    /// The price callback. Never panics on a bad reply: it records the failure so the dealer can retry.
    pub(crate) fn on_market_price_inner(&mut self, epoch: u64, requested_ns: u64) {
        if self.market.pending_epoch == epoch {
            self.market.pending_epoch = 0;
        }
        let raw = if env::promise_results_count() == 1 { env::promise_result_checked(0, 16 * 1024).ok() } else { None };
        let parsed = match raw {
            Some(bytes) => parse_oracle(&bytes, &self.market.token, requested_ns),
            None => Err("oracle_failed"),
        };
        let (price, ts) = match parsed {
            Ok(v) => v,
            Err(code) => {
                self.market.failures += 1;
                emit("market_price_failed", near_sdk::serde_json::json!({ "epoch": epoch, "reason": code }));
                return;
            }
        };
        if self.market.epoch != epoch {
            // the rounds were voided while the price was on its way
            emit("market_price_failed", near_sdk::serde_json::json!({ "epoch": epoch, "reason": "round_moved" }));
            return;
        }
        let now = env::block_timestamp();
        self.market.last_price = price;
        self.market.last_price_ns = now;
        if let Some(mut l) = self.live_round() {
            l.close_price = price;
            l.close_ts = ts;
            self.finish_round(l, Phase::Closed, now);
        }
        let mut open = self.market_round(epoch).expect("round");
        open.phase = Phase::Live;
        open.lock_price = price;
        open.lock_ts = ts;
        open.locked_at_ns = now;
        emit("market_round", near_sdk::serde_json::json!({ "epoch": epoch, "phase": "live", "lock_price": price, "bets": open.bets }));
        self.market.rounds.insert(epoch, open);
        self.new_round(epoch + 1, now);
        self.settle_market(SETTLE_IN_CALLBACK);
    }

    // ------------------------------------------------------------------ payouts

    /// Pays up to `limit` queued bets. Returns how many were paid.
    pub(crate) fn settle_market(&mut self, limit: u32) -> u32 {
        let mut done = 0;
        while done < limit {
            let Some(&epoch) = self.market.queue.first() else { break };
            let mut round = self.market_round(epoch).expect("round");
            while round.settled < round.bets && done < limit {
                let idx = round.settled;
                if let Some(bet) = self.market.bets.remove(&bet_key(epoch, idx)) {
                    self.market.mine.remove(&mine_key(epoch, &bet.player));
                    self.pay_market_bet(&round, bet);
                }
                round.settled += 1;
                done += 1;
            }
            let finished = round.settled >= round.bets;
            self.market.rounds.insert(epoch, round);
            if finished {
                self.market.queue.remove(0);
            }
        }
        done
    }

    fn pay_market_bet(&mut self, round: &Round, bet: MarketBet) {
        let outcome = outcome_of(round);
        let won = (outcome == "up" && bet.side == UP) || (outcome == "down" && bet.side == DOWN);
        let refund = outcome == "void" || outcome == "tie" || outcome.is_empty();
        self.reserved = self.reserved.saturating_sub(bet.hold);
        let base = if won { bet.hold } else if refund { bet.wager } else { 0 };
        let pay = base.min(self.vault);
        self.vault -= pay;
        let mut blessing = 0;
        if won {
            blessing = self.take_blessing(pay, bet.blessing_bps);
        } else if !refund {
            // a lost stake feeds the church and the jackpot like every other house game
            let t = apply_bps(bet.wager, TREASURY_BPS).min(self.vault);
            self.vault -= t;
            self.treasury += t;
            let j = apply_bps(bet.wager, JACKPOT_BPS).min(self.vault);
            self.vault -= j;
            self.jackpot += j;
        }
        let payout = pay + blessing;
        let (mut player, is_new) = self.touch(&bet.player);
        self.credit(&mut player, payout);
        let mut luck_gain = 0;
        if !refund {
            let chips = whole_chips(bet.wager, self.params.chip_yocto) as u32;
            luck_gain = add_luck(&mut player, self.luck_award(chips));
            player.stats.wagered = player.stats.wagered.saturating_add(bet.wager);
        }
        let label = if outcome.is_empty() { "void" } else { outcome };
        let stored = StoredResult {
            bet_id: bet.bet_id,
            game: GameKind::Market,
            wager: bet.wager,
            payout,
            blessing,
            luck_gain_milli: luck_gain,
            reels: Some(vec![cents_str(round.lock_price), cents_str(round.close_price)]),
            side: Some(side_str(bet.side).into()),
            dice: None,
            n: None,
            color: Some(label.into()),
            prize_chips: None,
            jackpot: false,
            server_seed: [0u8; 32],
            client_seed: [0u8; 32],
            chain_seed: [0u8; 32],
            block_seed: [0u8; 32],
            settled_height: env::block_height(),
            via_timeout: false,
            dealer_cards: None,
            shoe: None,
        };
        self.push_result(&bet.player, &mut player, stored);
        self.save(bet.player.clone(), player, is_new);
        emit("bet_settled", near_sdk::serde_json::json!({
            "account_id": bet.player.to_string(),
            "bet_id": bet.bet_id.to_string(),
            "game": "Market",
            "wager": bet.wager.to_string(),
            "payout": payout.to_string(),
            "blessing": blessing.to_string(),
            "luck_gain_milli": luck_gain,
            "epoch": round.epoch,
            "side": side_str(bet.side),
            "outcome": label,
            "lock_price": round.lock_price,
            "close_price": round.close_price,
            "via": "oracle",
        }));
    }

    // ------------------------------------------------------------------ views

    /// the unpaid bets of a round, in order (paid ones are in each player's results)
    pub(crate) fn market_bets_view(&self, epoch: u64, from: u32, limit: u32) -> Vec<RoundBetView> {
        let Some(r) = self.market_round(epoch) else { return Vec::new() };
        let start = from.max(r.settled);
        let end = r.bets.min(start.saturating_add(limit.min(100)));
        (start..end)
            .filter_map(|i| self.market.bets.get(&bet_key(epoch, i)))
            .map(|b| RoundBetView { bet_id: b.bet_id, player: b.player.clone(), side: side_str(b.side).into(), wager: U128(b.wager) })
            .collect()
    }

    pub(crate) fn market_view(&self, account_id: Option<AccountId>) -> MarketView {
        let m = &self.market;
        let now = env::block_timestamp();
        let open = if m.epoch > 0 { self.market_round(m.epoch) } else { None };
        let live = self.live_round();
        let mut recent = Vec::new();
        let mut e = m.epoch.saturating_sub(if live.is_some() { 2 } else { 1 });
        while e >= 1 && recent.len() < 12 {
            if let Some(r) = self.market_round(e) {
                if matches!(r.phase, Phase::Closed | Phase::Void) {
                    recent.push(round_view(&r));
                }
            } else {
                break;
            }
            e -= 1;
        }
        let mut mine = Vec::new();
        if let Some(who) = &account_id {
            for r in [&open, &live].into_iter().flatten() {
                if let Some(idx) = m.mine.get(&mine_key(r.epoch, who)) {
                    if let Some(b) = m.bets.get(&bet_key(r.epoch, *idx)) {
                        mine.push(MyMarketBet { epoch: r.epoch, bet_id: b.bet_id, side: side_str(b.side).into(), wager: U128(b.wager) });
                    }
                }
            }
        }
        let due = match &open {
            Some(o) => {
                let busy = m.pending_epoch != 0 && now < m.pending_ns + PENDING_STALE_NS;
                let need = o.bets > 0 || live.as_ref().map(|r| r.bets > 0).unwrap_or(false);
                m.enabled && !busy && need && now >= o.lock_ns
            }
            None => false,
        };
        MarketView {
            enabled: m.enabled,
            now_ns: U64(now),
            epoch: m.epoch,
            pending: m.pending_epoch != 0 && now < m.pending_ns + PENDING_STALE_NS,
            round_s: m.round_s,
            grace_s: m.grace_s,
            payout_bps: m.payout_bps,
            wagers: m.wagers.clone(),
            fee: U128(m.fee),
            token: m.token.clone(),
            outlayer: m.outlayer.clone(),
            source: m.source.clone(),
            open: open.as_ref().map(round_view),
            live: live.as_ref().map(round_view),
            recent,
            mine,
            last_price: m.last_price,
            last_price_ns: U64(m.last_price_ns),
            queue: m.queue.len() as u32,
            due,
            requests: m.requests,
            failures: m.failures,
            keeper: m.keeper.clone(),
        }
    }
}
