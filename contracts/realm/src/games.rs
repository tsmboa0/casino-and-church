//! Pure game tables. No storage, no env. Rust, Python and rules.ts must agree on these.
//! Payouts are floored to whole chips (house side) so they match `rules.ts`.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};

use crate::rng::mul_shift;
use crate::util::{must, whole_chips};

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum GameKind {
    Slots,
    Coin,
    Dice,
    Roulette,
    Wheel,
    Harmony,
    /// Single-deck blackjack. Settled by `blackjack_show`, not by `resolve`.
    Blackjack,
    /// BTC UP/DOWN rounds (market.rs). Never placed through `place_bet`; settled by the oracle price.
    Market,
}

pub fn parse_game(s: &str) -> GameKind {
    match s {
        "Slots" | "slots" => GameKind::Slots,
        "Coin" | "coin" | "coinflip" => GameKind::Coin,
        "Dice" | "dice" => GameKind::Dice,
        "Roulette" | "roulette" => GameKind::Roulette,
        "Wheel" | "wheel" => GameKind::Wheel,
        "Harmony" | "harmony" => GameKind::Harmony,
        "Blackjack" | "blackjack" => GameKind::Blackjack,
        _ => {
            must(false, "bad_args");
            unreachable!()
        }
    }
}

const SYMS: [&str; 5] = ["seven", "diamond", "clover", "coin", "cross"];
const SLOT_W: [u32; 5] = [4, 8, 14, 24, 50];
const SLOT_TRIPLE: [u32; 5] = [100, 40, 15, 8, 3];
const WHEEL: [(u32, u32); 6] = [(10, 30), (25, 30), (50, 20), (100, 15), (250, 4), (500, 1)];
/// Chip prizes; the last weight belongs to the jackpot.
const HARMONY_CHIPS: [(u32, u32); 4] = [(150, 40), (300, 30), (600, 20), (1500, 9)];
const HARMONY_JACKPOT_AT: u32 = 99; // weights sum to 99 before the jackpot's 1
const RED: [u8; 18] = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

pub const COIN_PAY_BPS: u128 = 19_400;
pub const DICE_OU_BPS: u128 = 22_800;
pub const DICE_SEVEN_BPS: u128 = 57_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    /// Base payout in yocto, before blessing. Zero when `jackpot` is set.
    pub base: u128,
    pub reels: Option<Vec<String>>,
    pub side: Option<String>,
    pub dice: Option<[u8; 2]>,
    pub n: Option<u8>,
    pub color: Option<String>,
    pub prize_chips: Option<u32>,
    pub jackpot: bool,
}

pub fn blessing_bps(faith_milli: u32) -> u16 {
    let faith = faith_milli / 1_000;
    if faith >= 100 {
        300
    } else if faith >= 75 {
        250
    } else if faith >= 50 {
        150
    } else if faith >= 25 {
        50
    } else {
        0
    }
}

/// Max base payout in yocto (blessing is treasury-funded and not reserved here).
pub fn max_base_payout(game: GameKind, wager: u128, chip: u128) -> u128 {
    match game {
        GameKind::Slots => whole_chips(wager, chip) * 100 * chip,
        GameKind::Coin => whole_chips(wager, chip) * COIN_PAY_BPS / 10_000 * chip,
        GameKind::Dice => whole_chips(wager, chip) * DICE_SEVEN_BPS / 10_000 * chip,
        GameKind::Roulette => whole_chips(wager, chip) * 36 * chip,
        GameKind::Wheel => 500 * chip,
        GameKind::Harmony => 1_500 * chip,
        // A doubled hand can return 4x the original wager (1:1 on twice the stake).
        GameKind::Blackjack => whole_chips(wager, chip) * 4 * chip,
        GameKind::Market => 0,
    }
}

pub fn resolve(game: GameKind, draws: &[u32; 8], pick: u8, wager: u128, chip: u128) -> Resolved {
    let chips = whole_chips(wager, chip);
    match game {
        GameKind::Slots => resolve_slots(draws, chips, chip),
        GameKind::Coin => resolve_coin(draws, pick, chips, chip),
        GameKind::Dice => resolve_dice(draws, pick, chips, chip),
        GameKind::Roulette => resolve_roulette(draws, pick, chips, chip),
        GameKind::Wheel => {
            let prize = weighted(draws[0], &WHEEL);
            Resolved {
                base: u128::from(prize) * chip,
                prize_chips: Some(prize),
                ..empty()
            }
        }
        GameKind::Harmony => {
            let r = mul_shift(draws[0], 100);
            if r >= HARMONY_JACKPOT_AT {
                return Resolved { jackpot: true, ..empty() };
            }
            let prize = weighted(draws[0], &HARMONY_CHIPS);
            Resolved {
                base: u128::from(prize) * chip,
                prize_chips: Some(prize),
                ..empty()
            }
        }
        GameKind::Blackjack | GameKind::Market => empty(),
    }
}

fn empty() -> Resolved {
    Resolved {
        base: 0,
        reels: None,
        side: None,
        dice: None,
        n: None,
        color: None,
        prize_chips: None,
        jackpot: false,
    }
}

fn reel(draw: u32) -> (usize, String) {
    let r = mul_shift(draw, 100);
    let mut acc = 0u32;
    for i in 0..5 {
        acc += SLOT_W[i];
        if r < acc {
            return (i, SYMS[i].to_string());
        }
    }
    (4, SYMS[4].to_string())
}

fn resolve_slots(draws: &[u32; 8], chips: u128, chip: u128) -> Resolved {
    let (i0, a) = reel(draws[0]);
    let (i1, b) = reel(draws[1]);
    let (i2, c) = reel(draws[2]);
    let pay_x = if i0 == i1 && i1 == i2 {
        SLOT_TRIPLE[i0]
    } else if i0 == i1 || i1 == i2 {
        1
    } else {
        0
    };
    Resolved {
        base: chips * u128::from(pay_x) * chip,
        reels: Some(vec![a, b, c]),
        ..empty()
    }
}

fn resolve_coin(draws: &[u32; 8], pick: u8, chips: u128, chip: u128) -> Resolved {
    let side = if mul_shift(draws[0], 2) == 0 { "H" } else { "T" };
    let win = (pick == 0 && side == "H") || (pick == 1 && side == "T");
    let base = if win { chips * COIN_PAY_BPS / 10_000 * chip } else { 0 };
    Resolved { base, side: Some(side.to_string()), ..empty() }
}

fn resolve_dice(draws: &[u32; 8], pick: u8, chips: u128, chip: u128) -> Resolved {
    let a = mul_shift(draws[0], 6) + 1;
    let b = mul_shift(draws[1], 6) + 1;
    let sum = a + b;
    // pick 3 is the field: 2 and 12 pay 2:1 (3x back), 3, 4, 9, 10, 11 pay 1:1.
    // 16 winning faces, total return 34 per 36. The first three picks stay on the bps table.
    if pick == 3 {
        let pay_x = match sum {
            2 | 12 => 3,
            3 | 4 | 9 | 10 | 11 => 2,
            _ => 0,
        };
        return Resolved {
            base: chips * pay_x * chip,
            dice: Some([a as u8, b as u8]),
            ..empty()
        };
    }
    let win = match pick {
        0 => sum < 7,
        1 => sum == 7,
        2 => sum > 7,
        _ => false,
    };
    let bps = if !win {
        0
    } else if pick == 1 {
        DICE_SEVEN_BPS
    } else {
        DICE_OU_BPS
    };
    Resolved {
        base: chips * bps / 10_000 * chip,
        dice: Some([a as u8, b as u8]),
        ..empty()
    }
}

fn is_red(n: u8) -> bool {
    RED.binary_search(&n).is_ok()
}

fn resolve_roulette(draws: &[u32; 8], pick: u8, chips: u128, chip: u128) -> Resolved {
    let n = mul_shift(draws[0], 37) as u8;
    let color = if n == 0 {
        "green"
    } else if is_red(n) {
        "red"
    } else {
        "black"
    };
    // Dozens (110..=112) and columns (120..=122) pay 2:1, three times the stake back.
    // Each covers 12 numbers, so the return is 36/37, the same as a straight-up.
    let (win, pay_x) = if pick <= 36 {
        (n == pick, 36u128)
    } else if n == 0 {
        (false, 0u128)
    } else {
        match pick {
            100 => (is_red(n), 2u128),
            101 => (!is_red(n), 2u128),
            102 => (n % 2 == 1, 2),
            103 => (n % 2 == 0, 2),
            104 => (n <= 18, 2),
            105 => (n >= 19, 2),
            110 => ((1..=12).contains(&n), 3),
            111 => ((13..=24).contains(&n), 3),
            112 => ((25..=36).contains(&n), 3),
            120 => (n % 3 == 1, 3),
            121 => (n % 3 == 2, 3),
            122 => (n % 3 == 0, 3),
            _ => (false, 0),
        }
    };
    Resolved {
        base: if win { chips * pay_x * chip } else { 0 },
        n: Some(n),
        color: Some(color.to_string()),
        ..empty()
    }
}

fn weighted(draw: u32, table: &[(u32, u32)]) -> u32 {
    let r = mul_shift(draw, 100);
    let mut acc = 0u32;
    for (prize, w) in table {
        acc += *w;
        if r < acc {
            return *prize;
        }
    }
    table[table.len() - 1].0
}

pub fn valid_pick(game: GameKind, pick: u8) -> bool {
    match game {
        GameKind::Slots | GameKind::Wheel | GameKind::Harmony => true,
        GameKind::Coin => pick <= 1,
        GameKind::Dice => pick <= 3,
        GameKind::Roulette => {
            pick <= 36
                || (100..=105).contains(&pick)
                || (110..=112).contains(&pick)
                || (120..=122).contains(&pick)
        }
        GameKind::Blackjack => pick == 0,
        GameKind::Market => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::{commit_of, draws_of, reveal_hash};
    use crate::util::from_hex_32;

    fn check_case(case: &serde_json::Value) {
        let server = from_hex_32(case["server"].as_str().unwrap()).unwrap();
        let client = from_hex_32(case["client"].as_str().unwrap()).unwrap();
        let chain = from_hex_32(case["chain"].as_str().unwrap()).unwrap();
        let bet_id = case["bet_id"].as_u64().unwrap();
        let h = reveal_hash(&server, &client, &chain, bet_id);
        assert_eq!(crate::util::to_hex(&h), case["h"].as_str().unwrap());
        assert_eq!(crate::util::to_hex(&commit_of(&server)), case["commit"].as_str().unwrap());
        let draws = draws_of(&h);
        let chip = 1u128;
        let slots = resolve(GameKind::Slots, &draws, 0, 1, chip);
        let reels: Vec<&str> = case["slots"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(slots.reels.as_ref().unwrap(), &reels.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
        assert_eq!(slots.base, case["slots_pay_x"].as_u64().unwrap() as u128);
        let coin = resolve(GameKind::Coin, &draws, 0, 10_000, chip);
        assert_eq!(coin.side.as_deref(), Some(case["coin"].as_str().unwrap()));
        let dice = resolve(GameKind::Dice, &draws, 0, 1, chip);
        let d = case["dice"].as_array().unwrap();
        assert_eq!(dice.dice, Some([d[0].as_u64().unwrap() as u8, d[1].as_u64().unwrap() as u8]));
        let roul = resolve(GameKind::Roulette, &draws, 0, 1, chip);
        assert_eq!(roul.n, Some(case["roulette_n"].as_u64().unwrap() as u8));
        assert_eq!(roul.color.as_deref(), Some(case["roulette_color"].as_str().unwrap()));
        let wheel = resolve(GameKind::Wheel, &draws, 0, 0, chip);
        assert_eq!(wheel.prize_chips, Some(case["wheel"].as_u64().unwrap() as u32));
        let harm = resolve(GameKind::Harmony, &draws, 0, 0, chip);
        if case["harmony"] == "JACKPOT" {
            assert!(harm.jackpot);
        } else {
            assert_eq!(harm.prize_chips, Some(case["harmony"].as_u64().unwrap() as u32));
        }
    }

    #[test]
    fn conformance_vectors() {
        let raw = include_str!("../vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let fixed = doc["fixed"].as_array().unwrap();
        let random = doc["random"].as_array().unwrap();
        assert_eq!(fixed.len(), 5);
        assert_eq!(random.len(), 1000);
        for case in fixed.iter().chain(random.iter()) {
            check_case(case);
        }
    }

    #[test]
    fn dice_field_and_roulette_layout_are_exact() {
        let mut field = 0u32;
        for a in 0..6u32 {
            for b in 0..6u32 {
                let draws = [draw_face(a), draw_face(b), 0, 0, 0, 0, 0, 0];
                let got = resolve_dice(&draws, 3, 1, 1);
                let sum = (a + 1 + b + 1) as u32;
                let pay = match sum {
                    2 | 12 => 3,
                    3 | 4 | 9 | 10 | 11 => 2,
                    _ => 0,
                };
                assert_eq!(got.base, u128::from(pay));
                field += pay;
                let under = resolve_dice(&draws, 0, 10_000, 1);
                let expect = if sum < 7 { 10_000 * DICE_OU_BPS / 10_000 } else { 0 };
                assert_eq!(under.base, expect);
            }
        }
        assert_eq!(field, 34, "field returns 34 units per 36 faces");

        for n in 0..37u32 {
            let draws = [draw_wheel(n, 37), 0, 0, 0, 0, 0, 0, 0];
            let straight = resolve_roulette(&draws, n as u8, 1, 1);
            assert_eq!(straight.n, Some(n as u8));
            assert_eq!(straight.base, 36);
            let dozen = if n == 0 { 0 } else { 110 + (n - 1) / 12 };
            let column = if n == 0 { 0 } else { 120 + (n - 1) % 3 };
            for pick in [100u8, 110, 111, 112, 120, 121, 122] {
                let got = resolve_roulette(&draws, pick, 1, 1);
                let win = match pick {
                    100 => n != 0 && is_red(n as u8),
                    110 => (1..=12).contains(&n),
                    111 => (13..=24).contains(&n),
                    112 => (25..=36).contains(&n),
                    120 => n % 3 == 1,
                    121 => n % 3 == 2,
                    122 => n != 0 && n % 3 == 0,
                    _ => false,
                };
                let pay = if pick == 100 { 2 } else { 3 };
                assert_eq!(got.base, if win { pay } else { 0 }, "n {n} pick {pick}");
            }
            if n != 0 {
                assert_eq!(resolve_roulette(&draws, dozen as u8, 1, 1).base, 3);
                assert_eq!(resolve_roulette(&draws, column as u8, 1, 1).base, 3);
            }
        }
    }

    fn draw_face(face: u32) -> u32 {
        draw_into(face, 6)
    }

    fn draw_wheel(face: u32, n: u32) -> u32 {
        draw_into(face, n)
    }

    fn draw_into(face: u32, n: u32) -> u32 {
        let mut draw = (((u64::from(face) << 32) + u64::from(n) - 1) / u64::from(n)) as u32;
        while mul_shift(draw, n) < face {
            draw += 1;
        }
        assert_eq!(mul_shift(draw, n), face);
        draw
    }

    #[test]
    fn blessing_tiers() {
        assert_eq!(blessing_bps(0), 0);
        assert_eq!(blessing_bps(24_999), 0);
        assert_eq!(blessing_bps(25_000), 50);
        assert_eq!(blessing_bps(50_000), 150);
        assert_eq!(blessing_bps(75_000), 250);
        assert_eq!(blessing_bps(100_000), 300);
    }
}
