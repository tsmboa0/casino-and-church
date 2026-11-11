//! Single-deck blackjack.
//!
//! Rules, fixed so the contract and the client can recompute every card:
//! - One deck. Fisher–Yates, one committed server seed per card. The player seed and the
//!   chain seed are mixed in, and both are fixed before the first card is shown.
//! - Deal is player, dealer upcard, player. There is no hole card yet (European dealing).
//! - Dealer stands on every 17, including soft 17. No split, no insurance, no surrender.
//! - Blackjack pays 3:2, floored to a whole chip. A normal win pays 1:1. A push returns the stake.
//! - The dealer does not peek. If the dealer’s first two cards are a natural after the player
//!   has finished, a doubled extra stake is returned and the original stake loses (original bets only).
//! - A player natural is paid immediately unless the upcard is an ace or a ten. Then the dealer
//!   turns one card. Two naturals push.
//! - Double is allowed on the first two cards only, and it takes exactly one more card.
//! - The hand reserves 18 seeds and 4x the wager. Silence is never cheaper than dealing:
//!   an unopened hand times out at 4x, a dealt hand the dealer will not finish times out at 1:1
//!   on the stake actually in play (2x the doubled stake). An idle player is stood, not paid.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::Serialize;
use near_sdk::{env, json_types::U128};

use crate::games::GameKind;
use crate::params::{JACKPOT_BPS, TREASURY_BPS};
use crate::rng::{commit_of, mul_shift};
use crate::util::{apply_bps, from_hex_32, must, sha256, to_hex, whole_chips};
use crate::Realm;

pub(crate) const BLACKJACK_COMMITS: u64 = 18;

const ST_PLAYER: u8 = 1;
const ST_NEED: u8 = 2;
const ST_PEEK: u8 = 3;
const ST_DEALER: u8 = 4;

const RANKS: &[u8] = b"A23456789TJQK";
const SUITS: &[u8] = b"CDHS";

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct BlackjackHand {
    pub deck: Vec<u8>,
    pub dealt: u8,
    pub player: Vec<u8>,
    pub dealer: Vec<u8>,
    pub stake: u128,
    pub doubled: bool,
    pub auto_stand: bool,
    pub stage: u8,
    pub last_height: u64,
    pub seeds: Vec<[u8; 32]>,
}

impl BlackjackHand {
    fn fresh(stake: u128) -> Self {
        Self {
            deck: (0..52).collect(),
            dealt: 0,
            player: Vec::new(),
            dealer: Vec::new(),
            stake,
            doubled: false,
            auto_stand: false,
            stage: ST_PLAYER,
            last_height: 0,
            seeds: Vec::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BlackjackView {
    pub bet_id: u64,
    pub stage: String,
    pub player: Vec<String>,
    pub dealer: Vec<String>,
    pub player_total: u8,
    pub dealer_total: u8,
    pub doubled: bool,
    pub stake: U128,
    pub original: U128,
    pub commit_idx: u64,
    pub cards_dealt: u8,
    pub client_seed: String,
    pub chain_seed: String,
    pub placed_height: u64,
    pub last_height: u64,
}

pub(crate) fn card_name(card: u8) -> String {
    let rank = RANKS[(card % 13) as usize] as char;
    let suit = SUITS[(card / 13) as usize] as char;
    format!("{rank}{suit}")
}

fn names(cards: &[u8]) -> Vec<String> {
    cards.iter().copied().map(card_name).collect()
}

/// `(total, soft)`. Soft means an ace is still counted as 11.
pub(crate) fn hand_total(cards: &[u8]) -> (u8, bool) {
    let mut sum = 0u16;
    let mut aces = 0u16;
    for card in cards {
        let rank = u16::from(card % 13);
        if rank == 0 {
            aces += 1;
            sum += 11;
        } else if rank >= 10 {
            sum += 10;
        } else {
            sum += rank + 1;
        }
    }
    while sum > 21 && aces > 0 {
        sum -= 10;
        aces -= 1;
    }
    (sum as u8, aces > 0)
}

fn ten_or_ace(card: u8) -> bool {
    let rank = card % 13;
    rank == 0 || rank >= 9
}

pub(crate) fn natural_payout(wager: u128, chip: u128) -> u128 {
    (whole_chips(wager, chip) * 5 / 2) * chip
}

/// Payout of a finished comparison, before blessing. `stake` is the chips in play.
pub(crate) fn table_payout(player: &[u8], dealer: &[u8], original: u128, stake: u128, chip: u128) -> (u128, &'static str) {
    let (pt, _) = hand_total(player);
    let (dt, _) = hand_total(dealer);
    let player_natural = player.len() == 2 && pt == 21;
    let dealer_natural = dealer.len() == 2 && dt == 21;
    if player_natural && dealer_natural {
        return (original, "push");
    }
    if player_natural {
        return (natural_payout(original, chip), "natural");
    }
    if dealer_natural {
        return (stake.saturating_sub(original), "lose");
    }
    if pt > 21 {
        return (0, "lose");
    }
    if dt > 21 || pt > dt {
        return (stake.saturating_mul(2), "win");
    }
    if pt == dt {
        return (stake, "push");
    }
    (0, "lose")
}

fn card_draw(seed: &[u8; 32], client: &[u8; 32], chain: &[u8; 32], bet_id: u64, n: u8) -> u32 {
    let mut buf = [0u8; 105];
    buf[..32].copy_from_slice(seed);
    buf[32..64].copy_from_slice(client);
    buf[64..96].copy_from_slice(chain);
    buf[96..104].copy_from_slice(&bet_id.to_le_bytes());
    buf[104] = n;
    let hash = sha256(&buf);
    u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]])
}

fn stage_name(stage: u8) -> &'static str {
    match stage {
        ST_PLAYER => "player",
        ST_NEED => "need_card",
        ST_PEEK => "peek",
        ST_DEALER => "dealer",
        _ => "undealt",
    }
}

impl Realm {
    pub(crate) fn view_blackjack(&self, bet_id: u64) -> Option<BlackjackView> {
        let bet = self.bets.get(&bet_id)?;
        if bet.game != GameKind::Blackjack {
            return None;
        }
        let stored = self.bj.get(&bet_id);
        let (stage, player, dealer, stake, doubled, dealt, last, player_total, dealer_total) = if let Some(hand) = stored {
            let (pt, _) = hand_total(&hand.player);
            let (dt, _) = hand_total(&hand.dealer);
            (
                stage_name(hand.stage).to_string(),
                names(&hand.player),
                names(&hand.dealer),
                hand.stake,
                hand.doubled,
                hand.dealt,
                hand.last_height,
                pt,
                dt,
            )
        } else {
            ("undealt".into(), Vec::new(), Vec::new(), bet.wager, false, 0, bet.placed_height, 0, 0)
        };
        Some(BlackjackView {
            bet_id,
            stage,
            player,
            dealer,
            player_total,
            dealer_total,
            doubled,
            stake: U128(stake),
            original: U128(bet.wager),
            commit_idx: bet.commit_idx,
            cards_dealt: dealt,
            client_seed: to_hex(&bet.client_seed),
            chain_seed: to_hex(&bet.chain_seed),
            placed_height: bet.placed_height,
            last_height: last,
        })
    }

    pub(crate) fn blackjack_act_inner(&mut self, bet_id: u64, action: String) {
        let bet = self.bets.get(&bet_id).cloned();
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        must(bet.game == GameKind::Blackjack, "bad_args");
        must(env::predecessor_account_id() == bet.player, "not_allowed");
        let mut hand = self.bj.get(&bet_id).cloned();
        must(hand.is_some(), "bad_args");
        let hand = hand.as_mut().unwrap();
        must(hand.stage == ST_PLAYER, "bad_args");
        let height = env::block_height();
        match action.as_str() {
            "stand" => hand.stage = ST_DEALER,
            "hit" => hand.stage = ST_NEED,
            "double" => {
                must(hand.player.len() == 2 && !hand.doubled, "bad_args");
                let extra = bet.wager;
                let id = bet.player.clone();
                let (mut player, is_new) = self.touch(&id);
                self.debit(&mut player, extra);
                let treasury = apply_bps(extra, TREASURY_BPS);
                let jackpot = apply_bps(extra, JACKPOT_BPS);
                self.treasury += treasury;
                self.jackpot += jackpot;
                self.vault += extra - treasury - jackpot;
                self.save(id, player, is_new);
                hand.stake += extra;
                hand.doubled = true;
                hand.auto_stand = true;
                hand.stage = ST_NEED;
            }
            _ => must(false, "bad_args"),
        }
        hand.last_height = height;
        let snapshot = hand.clone();
        self.bj.insert(bet_id, snapshot.clone());
        self.emit_hand(bet_id, snapshot);
    }

    pub(crate) fn blackjack_show_inner(&mut self, bet_id: u64, seeds: Vec<String>) {
        self.assert_dealer();
        self.assert_running();
        let bet = self.bets.get(&bet_id).cloned();
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        must(bet.game == GameKind::Blackjack, "bad_args");
        let mut parsed = Vec::with_capacity(seeds.len());
        for seed in &seeds {
            let bytes = from_hex_32(seed);
            must(bytes.is_some(), "bad_seed");
            parsed.push(bytes.unwrap());
        }
        if self.bj.get(&bet_id).is_none() {
            must(parsed.len() == 3, "bad_args");
            self.deal(bet_id, &bet, parsed);
        } else {
            must(parsed.len() == 1, "bad_args");
            let hand = self.bj.get(&bet_id).cloned().unwrap();
            self.step(bet_id, &bet, hand, parsed[0]);
        }
    }

    pub(crate) fn blackjack_timeout_inner(&mut self, bet_id: u64) {
        let bet = self.bets.get(&bet_id).cloned();
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        must(bet.game == GameKind::Blackjack, "bad_args");
        let height = env::block_height();
        let window = self.params.reveal_timeout_blocks;
        let hand = self.bj.get(&bet_id).cloned();
        if hand.is_none() {
            must(height >= bet.placed_height.saturating_add(window), "too_early");
            self.settle_blackjack(bet_id, bet.wager.saturating_mul(4), bet.wager, false, true, Vec::new(), Vec::new(), 0, "timeout", Vec::new());
            return;
        }
        let mut hand = hand.unwrap();
        must(height >= hand.last_height.saturating_add(window), "too_early");
        if hand.stage == ST_PLAYER {
            hand.stage = ST_DEALER;
            hand.last_height = height;
            self.bj.insert(bet_id, hand.clone());
            self.emit_hand(bet_id, hand);
            return;
        }
        let (amount, total) = if hand.stage == ST_PEEK {
            (natural_payout(bet.wager, self.params.chip_yocto), 21)
        } else {
            (hand.stake.saturating_mul(2), hand_total(&hand.player).0)
        };
        let player = names(&hand.player);
        let dealer = names(&hand.dealer);
        let shoe = hand.seeds.clone();
        let risked = hand.stake;
        self.settle_blackjack(bet_id, amount, risked, false, true, player, dealer, total, "timeout", shoe);
    }

    fn deal(&mut self, bet_id: u64, bet: &crate::player::Bet, seeds: Vec<[u8; 32]>) {
        let mut hand = BlackjackHand::fresh(bet.wager);
        for (i, seed) in seeds.into_iter().enumerate() {
            let card = self.draw_from(&mut hand, bet, bet_id, seed);
            if i == 1 {
                hand.dealer.push(card);
            } else {
                hand.player.push(card);
            }
        }
        hand.last_height = env::block_height();
        let (total, _) = hand_total(&hand.player);
        if total == 21 {
            if ten_or_ace(hand.dealer[0]) {
                hand.stage = ST_PEEK;
                self.bj.insert(bet_id, hand.clone());
                self.emit_hand(bet_id, hand);
            } else {
                let pay = natural_payout(bet.wager, self.params.chip_yocto);
                let player = names(&hand.player);
                let dealer = names(&hand.dealer);
                let shoe = hand.seeds.clone();
                self.bj.insert(bet_id, hand);
                self.settle_blackjack(bet_id, pay, bet.wager, true, false, player, dealer, 21, "natural", shoe);
            }
        } else {
            hand.stage = ST_PLAYER;
            self.bj.insert(bet_id, hand.clone());
            self.emit_hand(bet_id, hand);
        }
    }

    fn step(&mut self, bet_id: u64, bet: &crate::player::Bet, mut hand: BlackjackHand, seed: [u8; 32]) {
        let card = self.draw_from(&mut hand, bet, bet_id, seed);
        hand.last_height = env::block_height();
        let chip = self.params.chip_yocto;
        match hand.stage {
            ST_NEED => {
                hand.player.push(card);
                let (total, _) = hand_total(&hand.player);
                let auto = hand.auto_stand;
                hand.auto_stand = false;
                if total > 21 {
                    self.finish_table(bet_id, bet, &hand, chip);
                } else if auto || total == 21 {
                    hand.stage = ST_DEALER;
                    self.bj.insert(bet_id, hand.clone());
                    self.emit_hand(bet_id, hand);
                } else {
                    hand.stage = ST_PLAYER;
                    self.bj.insert(bet_id, hand.clone());
                    self.emit_hand(bet_id, hand);
                }
            }
            ST_PEEK => {
                hand.dealer.push(card);
                let (dt, _) = hand_total(&hand.dealer);
                self.bj.insert(bet_id, hand.clone());
                if dt == 21 {
                    self.finish_table(bet_id, bet, &hand, chip);
                } else {
                    let pay = natural_payout(bet.wager, chip);
                    let player = names(&hand.player);
                    let dealer = names(&hand.dealer);
                    let shoe = hand.seeds.clone();
                    self.settle_blackjack(bet_id, pay, bet.wager, true, false, player, dealer, 21, "natural", shoe);
                }
            }
            ST_DEALER => {
                hand.dealer.push(card);
                let (dt, _) = hand_total(&hand.dealer);
                let natural = hand.dealer.len() == 2 && dt == 21;
                self.bj.insert(bet_id, hand.clone());
                if natural || dt >= 17 {
                    self.finish_table(bet_id, bet, &hand, chip);
                } else {
                    self.emit_hand(bet_id, hand);
                }
            }
            _ => must(false, "bad_args"),
        }
    }

    fn finish_table(&mut self, bet_id: u64, bet: &crate::player::Bet, hand: &BlackjackHand, chip: u128) {
        let (pay, label) = table_payout(&hand.player, &hand.dealer, bet.wager, hand.stake, chip);
        let bless = label == "win" || label == "natural";
        let total = hand_total(&hand.player).0;
        self.settle_blackjack(
            bet_id,
            pay,
            hand.stake,
            bless,
            false,
            names(&hand.player),
            names(&hand.dealer),
            total,
            label,
            hand.seeds.clone(),
        );
    }

    fn draw_from(&self, hand: &mut BlackjackHand, bet: &crate::player::Bet, bet_id: u64, seed: [u8; 32]) -> u8 {
        let n = hand.dealt;
        must(n < 52, "bad_args");
        let idx = bet.commit_idx.saturating_add(u64::from(n));
        let committed = self.commits.get(&idx).cloned();
        must(committed.is_some(), "bad_seed");
        must(committed.unwrap() == commit_of(&seed), "bad_seed");
        let draw = card_draw(&seed, &bet.client_seed, &bet.chain_seed, bet_id, n);
        let span = 52 - u32::from(n);
        let j = mul_shift(draw, span) as usize;
        let i = n as usize;
        hand.deck.swap(i, i + j);
        let card = hand.deck[i];
        hand.dealt = n + 1;
        hand.seeds.push(seed);
        card
    }

    fn emit_hand(&self, bet_id: u64, hand: BlackjackHand) {
        let (total, _) = hand_total(&hand.player);
        crate::events::emit("blackjack", near_sdk::serde_json::json!({
            "bet_id": bet_id.to_string(),
            "stage": stage_name(hand.stage),
            "player": names(&hand.player),
            "dealer": names(&hand.dealer),
            "player_total": total,
            "doubled": hand.doubled,
            "cards_dealt": hand.dealt,
        }));
    }
}

#[cfg(test)]
mod hand_tests {
    use super::{hand_total, natural_payout, table_payout};

    #[test]
    fn soft_totals_and_the_pay_table() {
        assert_eq!(hand_total(&[0, 5]), (17, true));
        assert_eq!(hand_total(&[0, 0]), (12, true));
        assert_eq!(hand_total(&[9, 10, 4]), (25, false));
        let chip = 1u128;
        assert_eq!(natural_payout(25, chip), 62);
        assert_eq!(natural_payout(10, chip), 25);
        let player = [9u8, 10];
        let dealer = [9u8, 8];
        assert_eq!(table_payout(&player, &dealer, 10, 10, chip).1, "win");
        let bust = [9u8, 10, 4];
        assert_eq!(table_payout(&bust, &dealer, 10, 10, chip).0, 0);
        let bj_dealer = [0u8, 9];
        assert_eq!(hand_total(&bj_dealer).0, 21);
        assert_eq!(table_payout(&player, &bj_dealer, 10, 20, chip), (10, "lose"));
        assert_eq!(table_payout(&bj_dealer, &bj_dealer, 10, 10, chip), (10, "push"));
    }
}

