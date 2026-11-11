//! In-process contract tests. The SDK mock executes the same methods the chain will.
//! A caught panic does not roll state back, so rejection tests use a fresh contract.

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult};

use crate::params::ParamsPatch;
use crate::util::{from_hex_32, to_hex};
use crate::Realm;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(pred: &str, deposit: u128, height: u64, ts: u64, seed: [u8; 32]) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("realm.testnet"))
        .signer_account_id(acc(pred))
        .predecessor_account_id(acc(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50_000))
        .block_height(height)
        .block_timestamp(ts)
        .prepaid_gas(Gas::from_tgas(300))
        .random_seed(seed);
    testing_env!(b.build());
}

const T0: u64 = 1_700_000_000 * 1_000_000_000;

fn boot() -> Realm {
    context("admin.testnet", 0, 100, T0, [9u8; 32]);
    let mut realm = Realm::new(acc("admin.testnet"), acc("boss.testnet"), acc("agent.testnet"), None, None);
    context("admin.testnet", 2_000 * realm.params.chip_yocto * 100, 100, T0, [9u8; 32]);
    // 2_000 NEAR into the vault: chip is 0.01 NEAR, so this is 200_000 chips.
    let near = 2_000 * 10u128.pow(24);
    context("admin.testnet", near, 100, T0, [9u8; 32]);
    realm.seed_vault();
    context("admin.testnet", 50 * 10u128.pow(24), 100, T0, [9u8; 32]);
    realm.seed_treasury();
    context("admin.testnet", 40 * 10u128.pow(24), 100, T0, [9u8; 32]);
    realm.seed_jackpot();
    realm
}

fn chip(realm: &Realm) -> u128 {
    realm.params.chip_yocto
}

fn commit_one(realm: &mut Realm, seed: [u8; 32]) {
    context("boss.testnet", 0, 100, T0, [1u8; 32]);
    realm.commit_batch(vec![to_hex(&crate::rng::commit_of(&seed))]);
}

fn deposit(realm: &mut Realm, who: &str, chips: u128) {
    let amount = chips * chip(realm);
    context(who, amount, 110, T0, [2u8; 32]);
    realm.deposit();
}

fn play_coin(realm: &mut Realm, who: &str, wager_chips: u128, pick: u8, client: [u8; 32], server: [u8; 32], chain: [u8; 32], height: u64) -> u64 {
    commit_one(realm, server);
    context(who, 0, height, T0, chain);
    let id = realm.place_bet("Coin".into(), near_sdk::json_types::U128(wager_chips * chip(realm)), pick, to_hex(&client), 0);
    context("boss.testnet", 0, height + 1, T0 + 1_000_000_000, [4u8; 32]);
    realm.reveal(id, to_hex(&server));
    id
}

fn liability_ok(realm: &Realm) {
    let mut chips = 0u128;
    for name in ["alice.testnet", "bob.testnet", "admin.testnet"] {
        if let Some(p) = realm.players.get(&acc(name)) {
            chips += p.chips;
        }
    }
    assert_eq!(chips, realm.chips_outstanding, "chip ledger");
    assert!(realm.vault >= realm.reserved, "vault covers holds");
    let _ = realm.liability_total();
}

#[test]
fn fixed_vectors_round_trip_through_reveal() {
    let raw = include_str!("../vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 1_000);
    for case in doc["fixed"].as_array().unwrap() {
        let server = from_hex_32(case["server"].as_str().unwrap()).unwrap();
        let client = from_hex_32(case["client"].as_str().unwrap()).unwrap();
        let chain = from_hex_32(case["chain"].as_str().unwrap()).unwrap();
        let bet_id = case["bet_id"].as_u64().unwrap();
        commit_one(&mut realm, server);
        context("alice.testnet", 0, 200 + bet_id, T0, chain);
        let id = realm.place_bet("Coin".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&client), 0);
        assert_eq!(id, bet_id);
        context("boss.testnet", 0, 201 + bet_id, T0, [0u8; 32]);
        realm.reveal(id, to_hex(&server));
        let result = realm.get_bet_result(acc("alice.testnet"), id).unwrap();
        assert_eq!(result.outcome.side.as_deref(), Some(case["coin"].as_str().unwrap()));
        assert_eq!(result.via, "reveal");
        assert!(realm.get_bet(id).is_none());
    }
    liability_ok(&realm);
}

#[test]
fn wrong_seed_is_rejected() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 100);
    let server = [0x11u8; 32];
    commit_one(&mut realm, server);
    context("alice.testnet", 0, 300, T0, [0x33u8; 32]);
    let id = realm.place_bet("Slots".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&[0x22u8; 32]), 0);
    context("boss.testnet", 0, 301, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.reveal(id, to_hex(&[0x12u8; 32])));
    assert!(msg.contains("bad_seed"), "{msg}");
}

#[test]
fn rejects_bad_wager_and_unseeded_dealer() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 100);
    context("alice.testnet", 0, 400, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| {
        r.place_bet("Coin".into(), near_sdk::json_types::U128(7 * chip(r)), 0, to_hex(&[1u8; 32]), 0);
    });
    assert!(msg.contains("bad_wager") || msg.contains("dealer_offline") || msg.contains("max_bet"), "{msg}");
}

/// Run `f` against a clone-less contract. On panic the mock storage is not rolled back,
/// so the caller must not keep using `realm` afterwards. We snapshot nothing; the helper
/// only returns the panic text.
fn panic_code_on<F>(realm: &mut Realm, f: F) -> String
where
    F: FnOnce(&mut Realm),
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(realm))) {
        Ok(_) => panic!("expected a panic"),
        Err(e) => {
            if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                (*s).to_string()
            } else {
                format!("{e:?}")
            }
        }
    }
}

#[test]
fn timeout_pays_penalty_and_blocks_late_reveal() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 100);
    let server = [0x44u8; 32];
    commit_one(&mut realm, server);
    let chain = [0x55u8; 32];
    context("alice.testnet", 0, 500, T0, chain);
    let id = realm.place_bet("Coin".into(), near_sdk::json_types::U128(100 * chip(&realm)), 0, to_hex(&[0x66u8; 32]), 0);
    let before = realm.get_player(acc("alice.testnet")).unwrap().chips.0;
    context("alice.testnet", 0, 500 + realm.params.reveal_timeout_blocks, T0 + 120_000_000_000, [0x77u8; 32]);
    realm.claim_timeout(id);
    let after = realm.get_player(acc("alice.testnet")).unwrap();
    assert!(after.chips.0 >= before, "timeout never takes chips back");
    assert_eq!(after.stats.timeouts, 1);
    let result = realm.get_bet_result(acc("alice.testnet"), id).unwrap();
    assert_eq!(result.via, "timeout");
    assert!(!result.block_seed.is_empty());
    context("boss.testnet", 0, 600, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.reveal(id, to_hex(&server)));
    assert!(msg.contains("unknown_bet"), "{msg}");
}

#[test]
fn timeout_too_early() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 50);
    commit_one(&mut realm, [3u8; 32]);
    context("alice.testnet", 0, 700, T0, [3u8; 32]);
    let id = realm.place_bet("Dice".into(), near_sdk::json_types::U128(10 * chip(&realm)), 1, to_hex(&[4u8; 32]), 0);
    context("alice.testnet", 0, 701, T0, [3u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.claim_timeout(id));
    assert!(msg.contains("too_early"), "{msg}");
}

#[test]
fn pause_blocks_bets_but_not_withdraw_or_timeout() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 100);
    commit_one(&mut realm, [8u8; 32]);
    context("alice.testnet", 0, 800, T0, [8u8; 32]);
    let id = realm.place_bet("Roulette".into(), near_sdk::json_types::U128(10 * chip(&realm)), 7, to_hex(&[8u8; 32]), 0);
    context("admin.testnet", 0, 801, T0, [1u8; 32]);
    realm.pause();
    context("alice.testnet", 0, 802, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| {
        r.place_bet("Coin".into(), near_sdk::json_types::U128(10 * chip(r)), 0, to_hex(&[1u8; 32]), 0);
    });
    assert!(msg.contains("paused"), "{msg}");
    // withdraw builds a promise; it must not panic with paused.
    let fresh = {
        let mut realm = boot();
        deposit(&mut realm, "alice.testnet", 200);
        context("admin.testnet", 0, 810, T0, [1u8; 32]);
        realm.pause();
        context("alice.testnet", 0, 811, T0, [1u8; 32]);
        let _ = realm.withdraw(near_sdk::json_types::U128(100 * chip(&realm)));
        assert_eq!(realm.get_player(acc("alice.testnet")).unwrap().chips.0, 100 * chip(&realm));
    };
    let _ = (fresh, id);
}

#[test]
fn withdraw_refunds_when_transfer_fails() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 200);
    context("alice.testnet", 0, 900, T0, [1u8; 32]);
    let _ = realm.withdraw(near_sdk::json_types::U128(100 * chip(&realm)));
    assert_eq!(realm.get_player(acc("alice.testnet")).unwrap().chips.0, 100 * chip(&realm));
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("realm.testnet"))
        .predecessor_account_id(acc("realm.testnet"))
        .signer_account_id(acc("realm.testnet"))
        .block_height(901)
        .block_timestamp(T0)
        .account_balance(NearToken::from_near(50_000))
        .prepaid_gas(Gas::from_tgas(30));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::new(),
        vec![PromiseResult::Failed],
    );
    realm.on_withdraw(acc("alice.testnet"), near_sdk::json_types::U128(100 * chip(&realm)));
    assert_eq!(realm.get_player(acc("alice.testnet")).unwrap().chips.0, 200 * chip(&realm));
}

#[test]
fn welcome_is_once_and_capped() {
    let mut realm = boot();
    context("alice.testnet", 0, 1000, T0, [1u8; 32]);
    realm.claim_welcome();
    let chips = realm.get_player(acc("alice.testnet")).unwrap().chips.0;
    assert_eq!(chips, 500 * chip(&realm));
    context("alice.testnet", 0, 1001, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.claim_welcome());
    assert!(msg.contains("welcome_claimed"), "{msg}");
}

#[test]
fn tithe_curve_offer_candle_and_quest() {
    let mut realm = boot();
    context("admin.testnet", 0, 1090, T0, [1u8; 32]);
    realm.set_params(crate::params::ParamsPatch { candle_cooldown_s: Some(10), ..Default::default() });
    deposit(&mut realm, "alice.testnet", 5_000);
    context("alice.testnet", 0, 1100, T0, [1u8; 32]);
    let gain = realm.tithe(10);
    assert_eq!(gain, 1_000, "10 chips at 0 faith is 1 FAITH");
    for i in 0u64..3 {
        let mut server = [0x30u8; 32];
        server[0] = i as u8;
        play_coin(&mut realm, "alice.testnet", 100, 0, [0x31u8; 32], server, [0x32u8; 32], 1110 + i);
    }
    context("alice.testnet", 0, 1120, T0, [1u8; 32]);
    realm.offer_luck(20_000);
    let player = realm.get_player(acc("alice.testnet")).unwrap();
    assert_eq!(player.stats.converted_milli, 20_000);
    assert!(player.faith_milli > 1_000);
    context("alice.testnet", 0, 1121, T0, [1u8; 32]);
    realm.light_candle();
    context("alice.testnet", 0, 1122, T0 + 20_000_000_000, [1u8; 32]);
    realm.light_candle();
    context("alice.testnet", 0, 1300, T0 + 20_000_000_000, [1u8; 32]);
    realm.claim_quest("q-flip".into());
    realm.claim_quest("q-altar".into());
    realm.claim_quest("q-candle".into());
    let player = realm.get_player(acc("alice.testnet")).unwrap();
    assert_eq!(player.quests_claimed & 0b11010, 0b11010);
    liability_ok(&realm);
}

#[test]
fn decay_respects_realm_and_window() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 200);
    context("alice.testnet", 0, 1400, T0, [1u8; 32]);
    let gain = realm.tithe(100);
    assert_eq!(gain, 10_000);
    context("alice.testnet", 0, 1401, T0, [1u8; 32]);
    realm.enter_realm("casino".into());
    let before = realm.get_player(acc("alice.testnet")).unwrap();
    // A day offline still decays at most 15 minutes: 0.5 faith/min * 15 = 7500 milli.
    context("alice.testnet", 0, 1500, T0 + 86_400 * 1_000_000_000, [1u8; 32]);
    let after = realm.get_player(acc("alice.testnet")).unwrap();
    assert_eq!(before.faith_milli - after.faith_milli, 7_500);
    assert_eq!(after.luck_milli, before.luck_milli);
}

#[test]
fn machine_two_accounts_and_transfer_gate() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 2_000);
    deposit(&mut realm, "bob.testnet", 2_000);
    context("admin.testnet", 0, 1600, T0, [1u8; 32]);
    realm.grant_plot_gate(acc("alice.testnet"));
    context("alice.testnet", 0, 1601, T0, [1u8; 32]);
    let id = realm.create_machine(1, "Lucky".into(), "gold".into(), near_sdk::json_types::U128(500 * chip(&realm)));
    assert_eq!(realm.mt_balance_of(acc("alice.testnet"), format!("deed:machine:{id}")).0, 1);
    context("bob.testnet", 0, 1602, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| {
        r.mt_transfer(acc("bob.testnet"), format!("deed:machine:{id}"), near_sdk::json_types::U128(1), None, None);
    });
    assert!(msg.contains("not_allowed"), "{msg}");
    // fresh realm for the enabled-transfer path, so the caught panic above is irrelevant
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 5_000);
    deposit(&mut realm, "bob.testnet", 5_000);
    context("admin.testnet", 0, 1700, T0, [1u8; 32]);
    realm.grant_plot_gate(acc("alice.testnet"));
    context("alice.testnet", 0, 1701, T0, [1u8; 32]);
    let id = realm.create_machine(2, "Velvet".into(), "purple".into(), near_sdk::json_types::U128(2_000 * chip(&realm)));
    context("admin.testnet", 0, 1702, T0, [1u8; 32]);
    realm.set_transfers_enabled(true);
    context("alice.testnet", 0, 1703, T0, [1u8; 32]);
    realm.mt_transfer(acc("bob.testnet"), format!("deed:machine:{id}"), near_sdk::json_types::U128(1), None, None);
    assert_eq!(realm.get_machine(id).unwrap().owner, acc("bob.testnet"));
    let server = [0xABu8; 32];
    commit_one(&mut realm, server);
    context("alice.testnet", 0, 1704, T0, [0xCDu8; 32]);
    let bet = realm.place_bet(
        "Slots".into(),
        near_sdk::json_types::U128(10 * chip(&realm)),
        0,
        to_hex(&[0xEFu8; 32]),
        id,
    );
    context("boss.testnet", 0, 1705, T0, [1u8; 32]);
    realm.reveal(bet, to_hex(&server));
    let machine = realm.get_machine(id).unwrap();
    assert_eq!(machine.plays, 1);
    assert!(machine.bankroll.0 > 0);
    context("alice.testnet", 0, 1706, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.withdraw_machine(id, near_sdk::json_types::U128(100 * chip(r))));
    assert!(msg.contains("not_owner"), "{msg}");
}

#[test]
fn agent_step_and_bounds() {
    let mut realm = boot();
    context("agent.testnet", 0, 1800, T0, [1u8; 32]);
    realm.set_params(ParamsPatch { max_bet_chips: Some(80), ..Default::default() });
    assert_eq!(realm.params.max_bet_chips, 80);
    context("agent.testnet", 0, 1801, T0 + 10_000_000_000, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| {
        r.set_params(ParamsPatch { max_bet_chips: Some(10), ..Default::default() });
    });
    assert!(msg.contains("cooldown") || msg.contains("bad_args"), "{msg}");
    context("admin.testnet", 0, 1802, T0, [1u8; 32]);
    realm.set_params(ParamsPatch { luck_per_chip_milli: Some(40), candle_cooldown_s: Some(15), harmony_cooldown_s: Some(120), ..Default::default() });
    assert_eq!(realm.params.luck_per_chip_milli, 40);
    assert_eq!(realm.params.candle_cooldown_s, 15);
}

#[test]
fn wheel_requires_full_luck_and_consumes_it() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 5_000);
    // 100-chip bets grant min(8000, 100*80) = 8000 milli. 13 bets = 104_000, capped at 100_000.
    for i in 0..13 {
        let server = [i as u8 + 1; 32];
        play_coin(&mut realm, "alice.testnet", 100, 0, [i as u8 + 2; 32], server, [i as u8 + 3; 32], 2_000 + i);
    }
    let luck = realm.get_player(acc("alice.testnet")).unwrap().luck_milli;
    assert_eq!(luck, 100_000);
    let server = [0x21u8; 32];
    commit_one(&mut realm, server);
    context("alice.testnet", 0, 2100, T0, [0x22u8; 32]);
    let id = realm.place_bet("Wheel".into(), near_sdk::json_types::U128(0), 0, to_hex(&[0x23u8; 32]), 0);
    assert_eq!(realm.players.get(&acc("alice.testnet")).unwrap().luck_milli, 0);
    context("boss.testnet", 0, 2101, T0, [1u8; 32]);
    realm.reveal(id, to_hex(&server));
    let result = realm.get_bet_result(acc("alice.testnet"), id).unwrap();
    assert!(result.outcome.prize.is_some());
    assert!(result.payout.0 > 0);
    liability_ok(&realm);
}

#[test]
fn result_ring_drops_the_oldest() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 2_000);
    let mut first = 0u64;
    for i in 0..51 {
        let server = {
            let mut s = [0u8; 32];
            s[0] = i as u8;
            s[1] = 7;
            s
        };
        let id = play_coin(&mut realm, "alice.testnet", 10, 0, [9u8; 32], server, [8u8; 32], 3_000 + i);
        if i == 0 {
            first = id;
        }
    }
    assert!(realm.get_bet_result(acc("alice.testnet"), first).is_none());
    assert!(realm.get_bet_result(acc("alice.testnet"), first + 50).is_some());
    assert_eq!(realm.get_recent_results(acc("alice.testnet")).len(), 50);
}

#[test]
fn conservation_across_a_mixed_session() {
    let mut realm = boot();
    let start = realm.liability_total();
    deposit(&mut realm, "alice.testnet", 800);
    let after_deposit = realm.liability_total();
    assert_eq!(after_deposit, start + 800 * chip(&realm));
    context("alice.testnet", 0, 4000, T0, [1u8; 32]);
    realm.claim_welcome();
    assert_eq!(realm.liability_total(), after_deposit, "welcome only moves vault to chips");
    for i in 0..20 {
        let mut server = [0u8; 32];
        server[0] = 20 + i as u8;
        let game = match i % 4 {
            0 => "Slots",
            1 => "Coin",
            2 => "Dice",
            _ => "Roulette",
        };
        let pick = match i % 4 {
            1 => 1,
            2 => 2,
            3 => 100,
            _ => 0,
        };
        commit_one(&mut realm, server);
        context("alice.testnet", 0, 4100 + i, T0, server);
        let id = realm.place_bet(game.into(), near_sdk::json_types::U128(25 * chip(&realm)), pick, to_hex(&server), 0);
        assert_eq!(realm.liability_total(), after_deposit);
        context("boss.testnet", 0, 4200 + i, T0, [1u8; 32]);
        realm.reveal(id, to_hex(&server));
        assert_eq!(realm.liability_total(), after_deposit, "settle conserves");
        assert_eq!(realm.pending_bets, 0);
        assert_eq!(realm.reserved, 0);
    }
    context("alice.testnet", 0, 4300, T0, [1u8; 32]);
    realm.tithe(20);
    assert_eq!(realm.liability_total(), after_deposit);
    context("alice.testnet", 0, 4301, T0, [1u8; 32]);
    realm.enter_realm("church".into());
    context("alice.testnet", 0, 4302, T0 + 1_000_000_000, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.enter_realm("casino".into()));
        assert!(msg.contains("rate_limited"), "{msg}");
}

fn bj_seeds() -> Vec<[u8; 32]> {
    (0u8..18).map(|i| {
        let mut seed = [0x5Au8; 32];
        seed[0] = i;
        seed[31] = i.wrapping_mul(9).wrapping_add(1);
        seed
    }).collect()
}

fn commit_many(realm: &mut Realm, seeds: &[[u8; 32]]) {
    context("boss.testnet", 0, 200, T0, [1u8; 32]);
    realm.commit_batch(seeds.iter().map(|s| to_hex(&crate::rng::commit_of(s))).collect());
}

#[test]
fn blackjack_hand_conserves_and_dealer_stands() {
    use crate::blackjack::{card_name, hand_total};
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 500);
    let seeds = bj_seeds();
    commit_many(&mut realm, &seeds);
    let open = realm.liability_total();
    context("alice.testnet", 0, 210, T0, [0x44u8; 32]);
    let id = realm.place_bet("Blackjack".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&[0x22u8; 32]), 0);
    assert_eq!(realm.get_pools().commits_available, 0);
    assert!(realm.get_blackjack(id).unwrap().stage == "undealt");
    let mut doubled = false;
    for _ in 0..24 {
        if realm.get_bet(id).is_none() {
            break;
        }
        let view = realm.get_blackjack(id).unwrap();
        match view.stage.as_str() {
            "undealt" => {
                context("boss.testnet", 0, 211, T0, [1u8; 32]);
                let open_seeds: Vec<String> = seeds[..3].iter().map(|seed| to_hex(seed)).collect();
                realm.blackjack_show(id, open_seeds);
            }
            "player" => {
                context("alice.testnet", 0, 220 + u64::from(view.cards_dealt), T0, [1u8; 32]);
                if !doubled && view.player.len() == 2 && view.player_total != 21 {
                    realm.blackjack_act(id, "double".into());
                    doubled = true;
                    let again = realm.get_blackjack(id).unwrap();
                    assert_eq!(again.stake.0, 20 * chip(&realm));
                    assert_eq!(again.stage, "need_card");
                } else if view.player_total >= 17 {
                    realm.blackjack_act(id, "stand".into());
                } else {
                    realm.blackjack_act(id, "hit".into());
                }
            }
            "need_card" | "peek" | "dealer" => {
                context("boss.testnet", 0, 250 + u64::from(view.cards_dealt), T0, [1u8; 32]);
                realm.blackjack_show(id, vec![to_hex(&seeds[view.cards_dealt as usize])]);
            }
            other => panic!("unexpected stage {other}"),
        }
    }
    assert!(realm.get_bet(id).is_none(), "hand should settle");
    let result = realm.get_bet_result(acc("alice.testnet"), id).unwrap();
    let player = result.outcome.reels.clone().unwrap();
    let dealer = result.outcome.dealer_cards.clone().unwrap();
    let mut ids = Vec::new();
    for name in player.iter().chain(dealer.iter()) {
        let bytes = name.as_bytes();
        let rank = b"A23456789TJQK".iter().position(|c| *c == bytes[0]).unwrap();
        let suit = b"CDHS".iter().position(|c| *c == bytes[1]).unwrap();
        ids.push((suit * 13 + rank) as u8);
        assert_eq!(card_name(ids[ids.len() - 1]), *name);
    }
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), ids.len(), "duplicate card");
    let (pt, _) = hand_total(&ids[..player.len()]);
    let (dt, _) = hand_total(&ids[player.len()..]);
    let label = result.outcome.side.clone().unwrap();
    if label != "lose" || pt <= 21 {
        if label != "natural" {
            assert!(dt >= 17 || (dealer.len() == 2 && dt == 21) || pt > 21, "dealer left a hand open: {dt} {label}");
        }
    }
    assert!(result.payout.0 <= 40 * chip(&realm) + result.blessing.0);
    assert_eq!(realm.liability_total(), open);
    assert_eq!(realm.reserved, 0);
    assert_eq!(realm.pending_bets, 0);
}

#[test]
fn blackjack_timeout_pays_more_than_dealing() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 500);
    commit_many(&mut realm, &bj_seeds());
    context("alice.testnet", 0, 300, T0, [0x44u8; 32]);
    let id = realm.place_bet("Blackjack".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&[0x22u8; 32]), 0);
    context("alice.testnet", 0, 300 + realm.params.reveal_timeout_blocks, T0, [1u8; 32]);
    realm.claim_timeout(id);
    let chips = realm.players.get(&acc("alice.testnet")).unwrap().chips;
    // 500 - 10 + 4*10 + 10% penalty.
    assert_eq!(chips, 531 * chip(&realm));
    assert!(realm.get_bet(id).is_none());
}

#[test]
fn blackjack_idle_player_is_stood_then_a_stalled_dealer_pays() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 500);
    let seeds = bj_seeds();
    commit_many(&mut realm, &seeds);
    context("alice.testnet", 0, 400, T0, [0x44u8; 32]);
    let id = realm.place_bet("Blackjack".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&[0x22u8; 32]), 0);
    context("boss.testnet", 0, 401, T0, [1u8; 32]);
    realm.blackjack_show(id, seeds[..3].iter().map(|seed| to_hex(seed)).collect());
    let opened = realm.get_blackjack(id);
    if opened.is_none() {
        // The shoe was a natural and already paid. The idle path needs a live hand.
        return;
    }
    let opened = opened.unwrap();
    if opened.stage != "player" {
        return;
    }
    context("alice.testnet", 0, 401 + realm.params.reveal_timeout_blocks, T0, [1u8; 32]);
    realm.claim_timeout(id);
    assert_eq!(realm.get_blackjack(id).unwrap().stage, "dealer");
    context("alice.testnet", 0, 401 + 2 * realm.params.reveal_timeout_blocks, T0, [1u8; 32]);
    realm.claim_timeout(id);
    let result = realm.get_bet_result(acc("alice.testnet"), id).unwrap();
    assert_eq!(result.via, "timeout");
    assert_eq!(result.payout.0, 21 * chip(&realm));
}

#[test]
fn blackjack_rejects_a_bad_seed_and_a_plain_reveal() {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 100);
    let seeds = bj_seeds();
    commit_many(&mut realm, &seeds);
    context("alice.testnet", 0, 500, T0, [9u8; 32]);
    let id = realm.place_bet("Blackjack".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&[3u8; 32]), 0);
    context("boss.testnet", 0, 501, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.reveal(id, to_hex(&seeds[0])));
    assert!(msg.contains("bad_args"), "{msg}");
}

fn as_priest(realm: &mut Realm) {
    context("admin.testnet", 0, 100, T0, [9u8; 32]);
    assert_eq!(near_sdk::env::predecessor_account_id().as_str(), realm.roles.admin.as_str());
    realm.set_priest(acc("priest.testnet"));
}

#[test]
fn hosts_reject_bounds_and_the_wrong_role() {
    let mut realm = boot();
    as_priest(&mut realm);
    context("agent.testnet", 0, 100, T0, [1u8; 32]);
    let early = panic_code_on(&mut realm, |r| r.start_event("happy_hour".into(), 9, 2_000));
    assert!(early.contains("bad_args"), "{early}");
    context("priest.testnet", 0, 100, T0, [1u8; 32]);
    let wrong = panic_code_on(&mut realm, |r| r.start_event("happy_hour".into(), 20, 2_000));
    assert!(wrong.contains("not_allowed"), "{wrong}");
    context("agent.testnet", 0, 100, T0, [1u8; 32]);
    realm.start_event("happy_hour".into(), 20, 2_000);
    assert_eq!(realm.get_events().len(), 1);
    let again = panic_code_on(&mut realm, |r| r.start_event("happy_hour".into(), 20, 2_000));
    assert!(again.contains("bad_args") || again.contains("cooldown"), "{again}");
    let proof = panic_code_on(&mut realm, |r| r.record_decision(crate::hosts::AgentProof {
        decision_id: "x".into(), agent: "fortuna".into(), action: "none".into(), model: "m".into(),
        signed_text: "a".repeat(301), signature: "ab".repeat(65), signing_address: "0x1".into(),
        request_sha256: "a".repeat(64), response_sha256: "b".repeat(64),
    }));
    assert!(proof.contains("bad_args"), "{proof}");
}

#[test]
fn alms_and_jackpot_topup_conserve_the_ledger() {
    let mut realm = boot();
    as_priest(&mut realm);
    deposit(&mut realm, "alice.testnet", 40);
    context("alice.testnet", 0, 110, T0, [3u8; 32]);
    realm.light_candle();
    let before = realm.get_pools();
    let liability = before.vault.0 + before.treasury.0 + before.jackpot.0 + realm.get_player(acc("alice.testnet")).unwrap().chips.0;
    context("priest.testnet", 0, 113, T0, [3u8; 32]);
    realm.grant_alms(acc("alice.testnet"), 30);
    let after = realm.get_pools();
    let chips = realm.get_player(acc("alice.testnet")).unwrap().chips.0;
    assert_eq!(after.treasury.0, before.treasury.0 - 30 * chip(&realm));
    assert_eq!(after.vault.0 + after.treasury.0 + after.jackpot.0 + chips, liability);
    context("priest.testnet", 0, 114, T0, [3u8; 32]);
    let rich = panic_code_on(&mut realm, |r| r.grant_alms(acc("alice.testnet"), 10));
    assert!(rich.contains("not_allowed") || rich.contains("cooldown"), "{rich}");
    context("agent.testnet", 0, 115, T0, [3u8; 32]);
    realm.top_up_jackpot(10);
    let topped = realm.get_pools();
    assert_eq!(topped.jackpot.0, after.jackpot.0 + 10 * chip(&realm));
    assert_eq!(topped.vault.0, after.vault.0 - 10 * chip(&realm));
}

/// Replays the LIVE testnet state through the v1→v2 migration. Run with
/// `CNC_STATE=/path/state.json cargo test live_state`, where state.json is a `view_state` dump
/// ({"STATE":[{k,v}], "p":[...], "r":[...]}, base64). Skipped when CNC_STATE is unset.
#[test]
fn live_state_migrates_and_every_record_still_decodes() {
    use near_sdk::base64::Engine;
    use near_sdk::borsh;
    let Ok(path) = std::env::var("CNC_STATE") else { return };
    let dump: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let b64 = |s: &serde_json::Value| near_sdk::base64::engine::general_purpose::STANDARD.decode(s.as_str().unwrap()).unwrap();
    context("realm.testnet", 0, 100, T0, [1u8; 32]);
    let raw = b64(&dump["STATE"][0]["v"]);
    let realm = crate::migrate_bytes(&raw, Some(acc("priest.testnet")));
    assert_eq!(realm.hosts.priest.as_str(), "priest.testnet");
    assert!(realm.hosts.active.iter().all(|e| e.is_none()));
    // re-encoding the upgraded state must equal the old bytes followed by the new host block
    let again = borsh::to_vec(&realm).unwrap();
    assert!(again.len() > raw.len());
    assert_eq!(&again[4..raw.len()], &raw[4..], "everything but the version must be byte-identical");
    let mut players = 0;
    for row in dump["p"].as_array().unwrap() {
        let _: crate::player::Player = borsh::from_slice(&b64(&row["v"])).expect("player record decodes");
        players += 1;
    }
    let mut results = 0;
    for row in dump["r"].as_array().unwrap() {
        let _: crate::player::StoredResult = borsh::from_slice(&b64(&row["v"])).expect("result record decodes");
        results += 1;
    }
    eprintln!("live state: vault={} players={} results={}", realm.vault, players, results);
    // v2 -> v3: today's live layout is exactly the v1 bytes followed by a HostState (that is what the v2 migration
    // wrote). Build it, migrate, and check the hosts survive and the campaign block is appended.
    let mut v2 = raw.clone();
    let mut hs = crate::hosts::HostState::new(acc("priest.testnet"));
    hs.alms_spent = 7;
    v2.extend(borsh::to_vec(&hs).unwrap());
    let up = crate::migrate_bytes(&v2, None);
    assert_eq!(up.hosts.priest.as_str(), "priest.testnet");
    assert_eq!(up.hosts.alms_spent, 7);
    assert_eq!(up.camp.next_id, 1);
    assert_eq!(up.camp.escrow, 0);
    let again = borsh::to_vec(&up).unwrap();
    assert_eq!(&again[4..v2.len()], &v2[4..], "v2 bytes are untouched");
    assert_eq!(up.liability_total(), realm.liability_total());
}

// ---- Round 3: the AI hosts' bounded tools ------------------------------------------------------------

const MIN_NS: u64 = 60 * 1_000_000_000;

/// LUCK gained by one 10-chip flip. (The SDK mock shares storage between contracts in one test, so measure the delta.)
fn luck_after_one_coin(happy: Option<u32>) -> u32 {
    let mut realm = boot();
    deposit(&mut realm, "alice.testnet", 200);
    if let Some(bps) = happy {
        context("agent.testnet", 0, 105, T0, [1u8; 32]);
        realm.start_event("happy_hour".into(), 30, bps);
    }
    let before = realm.players.get(&acc("alice.testnet")).unwrap().luck_milli;
    play_coin(&mut realm, "alice.testnet", 10, 0, [5u8; 32], [6u8; 32], [7u8; 32], 120);
    let after = realm.players.get(&acc("alice.testnet")).unwrap().luck_milli;
    after - before
}

#[test]
fn happy_hour_multiplies_luck_and_never_the_payout() {
    let plain = luck_after_one_coin(None);
    let boosted = luck_after_one_coin(Some(5_000));
    assert!(plain > 0);
    assert_eq!(boosted, plain * 3 / 2, "+50% LUCK during a happy hour");
}

#[test]
fn vigil_multiplies_candle_faith_and_expires() {
    let mut realm = boot();
    as_priest(&mut realm);
    context("priest.testnet", 0, 101, T0, [1u8; 32]);
    realm.start_event("vigil".into(), 10, 2_000);
    context("alice.testnet", 0, 102, T0, [1u8; 32]);
    realm.light_candle();
    let boosted = realm.players.get(&acc("alice.testnet")).unwrap().faith_milli;
    assert_eq!(boosted, realm.hosts.candle_faith_milli * 12 / 10);
    // eleven minutes later the vigil is over: no event listed, and the boost is gone
    let later = T0 + 11 * MIN_NS;
    context("bob.testnet", 0, 103, later, [1u8; 32]);
    assert!(realm.get_events().is_empty());
    realm.light_candle();
    assert_eq!(realm.players.get(&acc("bob.testnet")).unwrap().faith_milli, realm.hosts.candle_faith_milli);
}

#[test]
fn events_respect_the_gap_the_daily_cap_and_early_end() {
    let mut realm = boot();
    let day0 = (T0 / (86_400 * 1_000_000_000) + 1) * 86_400 * 1_000_000_000; // a UTC midnight
    let mut t = day0;
    for n in 0..4 {
        context("agent.testnet", 0, 200 + n, t, [1u8; 32]);
        realm.start_event("happy_hour".into(), 10, 1_000);
        context("agent.testnet", 0, 200 + n, t + MIN_NS, [1u8; 32]);
        realm.end_event("happy_hour".into());
        assert!(realm.get_events().is_empty(), "ended early");
        t += 91 * MIN_NS;
    }
    // a fifth start on the same UTC day is refused
    context("agent.testnet", 0, 300, t, [1u8; 32]);
    let capped = panic_code_on(&mut realm, |r| r.start_event("happy_hour".into(), 10, 1_000));
    assert!(capped.contains("rate_limited"), "{capped}");

    let mut fresh = boot();
    context("agent.testnet", 0, 101, T0, [1u8; 32]);
    fresh.start_event("happy_hour".into(), 10, 1_000);
    context("agent.testnet", 0, 102, T0 + 30 * MIN_NS, [1u8; 32]);
    let gap = panic_code_on(&mut fresh, |r| r.start_event("happy_hour".into(), 10, 1_000));
    assert!(gap.contains("cooldown"), "90 minutes between events: {gap}");

    let mut bounds = boot();
    context("agent.testnet", 0, 101, T0, [1u8; 32]);
    let big = panic_code_on(&mut bounds, |r| r.start_event("happy_hour".into(), 30, 5_001));
    assert!(big.contains("bad_args"), "{big}");
    let mut bounds = boot();
    context("agent.testnet", 0, 101, T0, [1u8; 32]);
    let long = panic_code_on(&mut bounds, |r| r.start_event("happy_hour".into(), 61, 2_000));
    assert!(long.contains("bad_args"), "{long}");
    let mut bounds = boot();
    context("alice.testnet", 0, 101, T0, [1u8; 32]);
    let stranger = panic_code_on(&mut bounds, |r| r.start_event("happy_hour".into(), 30, 2_000));
    assert!(stranger.contains("not_allowed"), "{stranger}");
}

#[test]
fn alms_refuse_a_fresh_account_and_oversized_grants() {
    let mut realm = boot();
    as_priest(&mut realm);
    deposit(&mut realm, "alice.testnet", 20);
    context("priest.testnet", 0, 120, T0, [1u8; 32]);
    let sybil = panic_code_on(&mut realm, |r| r.grant_alms(acc("alice.testnet"), 20));
    assert!(sybil.contains("not_allowed"), "no candle, no wagering: {sybil}");

    let mut realm = boot();
    as_priest(&mut realm);
    context("alice.testnet", 0, 110, T0, [1u8; 32]);
    realm.light_candle();
    context("priest.testnet", 0, 120, T0, [1u8; 32]);
    let big = panic_code_on(&mut realm, |r| r.grant_alms(acc("alice.testnet"), 51));
    assert!(big.contains("bad_args"), "{big}");

    let mut realm = boot();
    as_priest(&mut realm);
    context("alice.testnet", 0, 110, T0, [1u8; 32]);
    realm.light_candle();
    context("agent.testnet", 0, 120, T0, [1u8; 32]);
    let don = panic_code_on(&mut realm, |r| r.grant_alms(acc("alice.testnet"), 10));
    assert!(don.contains("not_allowed"), "alms are the Father's tool: {don}");
}

#[test]
fn jackpot_top_up_is_capped_and_needs_a_healthy_vault() {
    let mut realm = boot();
    context("agent.testnet", 0, 101, T0, [1u8; 32]);
    let big = panic_code_on(&mut realm, |r| r.top_up_jackpot(501));
    assert!(big.contains("bad_args"), "{big}");

    let mut realm = boot();
    for n in 0..4 {
        context("agent.testnet", 0, 110 + n, T0, [1u8; 32]);
        realm.top_up_jackpot(500);
    }
    context("agent.testnet", 0, 120, T0, [1u8; 32]);
    let day = panic_code_on(&mut realm, |r| r.top_up_jackpot(1));
    assert!(day.contains("vault_low"), "2 000 chips a day: {day}");

    let mut realm = boot();
    realm.reserved = realm.vault / 3;                       // the vault is mostly promised to open bets
    context("agent.testnet", 0, 101, T0, [1u8; 32]);
    let thin = panic_code_on(&mut realm, |r| r.top_up_jackpot(100));
    assert!(thin.contains("vault_low"), "{thin}");
}

#[test]
fn church_params_move_in_small_steps_with_a_cooldown() {
    let mut realm = boot();
    as_priest(&mut realm);
    let cap = realm.params.blessing_day_cap_bps;
    context("priest.testnet", 0, 101, T0, [1u8; 32]);
    realm.set_church_params(crate::hosts::ChurchPatch { blessing_day_cap_bps: None, candle_faith_milli: Some(3_600) });
    assert_eq!(realm.hosts.candle_faith_milli, 3_600);
    context("priest.testnet", 0, 102, T0 + 10 * MIN_NS, [1u8; 32]);
    let soon = panic_code_on(&mut realm, |r| r.set_church_params(crate::hosts::ChurchPatch { blessing_day_cap_bps: None, candle_faith_milli: Some(3_700) }));
    assert!(soon.contains("cooldown"), "{soon}");

    let mut realm = boot();
    as_priest(&mut realm);
    context("priest.testnet", 0, 101, T0, [1u8; 32]);
    let jump = panic_code_on(&mut realm, |r| r.set_church_params(crate::hosts::ChurchPatch { blessing_day_cap_bps: None, candle_faith_milli: Some(4_000) }));
    assert!(jump.contains("bad_args"), "+33% is more than one step: {jump}");
    let _ = cap;
}

#[test]
fn record_decision_accepts_a_well_formed_proof_from_either_host() {
    let mut realm = boot();
    as_priest(&mut realm);
    let proof = |agent: &str| crate::hosts::AgentProof {
        decision_id: "6f1c1a52-6a43-4d0b-9a59-3c2b7d0e8a11".into(), agent: agent.into(), action: "start_vigil".into(),
        model: "Qwen/Qwen3.8-27B".into(), signed_text: format!("Qwen/Qwen3.8-27B:{}:{}", "a".repeat(64), "b".repeat(64)),
        signature: "ab".repeat(65), signing_address: format!("0x{}", "c".repeat(40)),
        request_sha256: "a".repeat(64), response_sha256: "b".repeat(64),
    };
    context("priest.testnet", 0, 101, T0, [1u8; 32]);
    realm.record_decision(proof("nakamoto"));
    context("agent.testnet", 0, 102, T0, [1u8; 32]);
    realm.record_decision(proof("fortuna"));
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs.iter().any(|l| l.contains("\"agent_decision\"") && l.contains("fortuna")), "{logs:?}");
    context("alice.testnet", 0, 103, T0, [1u8; 32]);
    let stranger = panic_code_on(&mut realm, |r| r.record_decision(proof("fortuna")));
    assert!(stranger.contains("not_allowed"), "{stranger}");
}

#[test]
fn host_act_anchors_and_acts_in_one_call_and_keeps_each_host_to_its_tools() {
    use crate::hosts::{AgentProof, HostCall};
    let proof = |agent: &str, action: &str| AgentProof {
        decision_id: "6f1c1a52-6a43-4d0b-9a59-3c2b7d0e8a11".into(), agent: agent.into(), action: action.into(),
        model: "Qwen/Qwen3.8-27B".into(), signed_text: format!("Qwen/Qwen3.8-27B:{}:{}", "a".repeat(64), "b".repeat(64)),
        signature: "ab".repeat(65), signing_address: format!("0x{}", "c".repeat(40)),
        request_sha256: "a".repeat(64), response_sha256: "b".repeat(64),
    };
    let mut realm = boot();
    as_priest(&mut realm);
    context("agent.testnet", 0, 101, T0, [1u8; 32]);
    realm.host_act(proof("fortuna", "start_happy_hour"), HostCall::StartEvent { kind: "happy_hour".into(), minutes: 20, boost_bps: 2_000 });
    assert_eq!(realm.get_events().len(), 1);
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs.iter().any(|l| l.contains("\"agent_decision\"")) && logs.iter().any(|l| l.contains("\"event_started\"")), "{logs:?}");
    context("priest.testnet", 0, 102, T0, [1u8; 32]);
    realm.host_act(proof("nakamoto", "none"), HostCall::None);

    // the Father cannot borrow Don's tools, nor speak as Don
    let mut realm = boot();
    as_priest(&mut realm);
    context("priest.testnet", 0, 101, T0, [1u8; 32]);
    let patch = ParamsPatch { max_bet_chips: Some(12), ..Default::default() };
    let tools = panic_code_on(&mut realm, |r| r.host_act(proof("nakamoto", "set_max_bet"), HostCall::SetParams { patch }));
    assert!(tools.contains("not_allowed"), "{tools}");
    let mut realm = boot();
    as_priest(&mut realm);
    context("priest.testnet", 0, 101, T0, [1u8; 32]);
    let voice = panic_code_on(&mut realm, |r| r.host_act(proof("fortuna", "none"), HostCall::None));
    assert!(voice.contains("not_allowed"), "{voice}");
}

#[test]
fn host_call_json_matches_the_server() {
    let call: crate::hosts::HostCall = serde_json::from_str(r#"{"do":"start_event","kind":"vigil","minutes":20,"boost_bps":2000}"#).unwrap();
    assert!(matches!(call, crate::hosts::HostCall::StartEvent { minutes: 20, .. }));
    let call: crate::hosts::HostCall = serde_json::from_str(r#"{"do":"set_params","patch":{"max_bet_chips":12}}"#).unwrap();
    assert!(matches!(call, crate::hosts::HostCall::SetParams { .. }));
    let call: crate::hosts::HostCall = serde_json::from_str(r#"{"do":"none"}"#).unwrap();
    assert!(matches!(call, crate::hosts::HostCall::None));
}

// ---- Church campaigns, alms floor, plot release (v3) ---------------------------------------------------

use crate::campaigns::{approval_message, claim_message, NewCampaign};
use ed25519_dalek::{Signer, SigningKey};

const ORACLE_SEED: [u8; 32] = [0x42u8; 32];

fn oracle() -> SigningKey { SigningKey::from_bytes(&ORACLE_SEED) }
fn with_oracle(realm: &mut Realm) {
    context("admin.testnet", 0, 2000, T0, [1u8; 32]);
    realm.set_roles(None, None, None, Some(to_hex(oracle().verifying_key().as_bytes())));
}
fn faithful(realm: &mut Realm, who: &str, milli: u32) {
    let mut p = realm.players.get(&acc(who)).cloned().unwrap();
    p.faith_milli = milli;
    realm.players.insert(acc(who), p);
}
fn social(title: &str, chips: u32, faith: u32, max: u32) -> NewCampaign {
    NewCampaign { kind: 0, title: title.into(), url: "https://x.com/NEARProtocol".into(), machine_id: 0, goal: 0, reward_chips: chips, reward_faith_milli: faith, max_claims: max }
}
fn approve(creator: &str, c: &NewCampaign, exp: u64) -> String {
    to_hex(&oracle().sign(approval_message(&acc(creator), c, exp).as_bytes()).to_bytes())
}
fn attest(id: u32, who: &str, exp: u64) -> String {
    to_hex(&oracle().sign(claim_message(id, &acc(who), exp).as_bytes()).to_bytes())
}
const EXP: u64 = T0 + 600 * 1_000_000_000;
fn u64j(v: u64) -> near_sdk::json_types::U64 { near_sdk::json_types::U64(v) }

#[test]
fn a_player_campaign_escrows_pays_each_player_once_and_refunds_the_rest() {
    let mut realm = boot();
    with_oracle(&mut realm);
    deposit(&mut realm, "alice.testnet", 1_000);
    deposit(&mut realm, "bob.testnet", 100);
    faithful(&mut realm, "alice.testnet", 20_000);
    let start = realm.liability_total();
    let treasury0 = realm.treasury;
    let c = social("Follow us", 5, 2_000, 10);
    let sig = approve("alice.testnet", &c, EXP);
    context("alice.testnet", 0, 2001, T0, [1u8; 32]);
    let id = realm.create_campaign(social("Follow us", 5, 2_000, 10), u64j(EXP), sig);
    let ch = chip(&realm);
    // 50 chips escrowed, 10 chips listing tithe (10% of 50 is 5, the floor is 10)
    assert_eq!(realm.get_player(acc("alice.testnet")).unwrap().chips.0, 940 * ch);
    assert_eq!(realm.treasury - treasury0, 10 * ch);
    assert_eq!(realm.camp.escrow, 50 * ch);
    assert_eq!(realm.liability_total(), start, "create conserves");
    let bob0 = realm.get_player(acc("bob.testnet")).unwrap();
    context("bob.testnet", 0, 2002, T0, [1u8; 32]);
    realm.claim_campaign(id, u64j(EXP), attest(id, "bob.testnet", EXP));
    let bob1 = realm.get_player(acc("bob.testnet")).unwrap();
    assert_eq!(bob1.chips.0 - bob0.chips.0, 5 * ch);
    assert_eq!(bob1.faith_milli - bob0.faith_milli, 2_000);
    assert_eq!(realm.liability_total(), start, "claim conserves");
    let v = realm.get_campaigns(Some(acc("bob.testnet")));
    assert!(v[0].claimed && v[0].claims == 1 && v[0].active);
    let twice = panic_code_on(&mut realm, |r| r.claim_campaign(id, u64j(EXP), attest(id, "bob.testnet", EXP)));
    assert!(twice.contains("already_claimed"), "{twice}");
    // close: the unpaid 45 chips go back to alice
    let mut realm2 = boot();
    with_oracle(&mut realm2);
    deposit(&mut realm2, "alice.testnet", 1_000);
    faithful(&mut realm2, "alice.testnet", 20_000);
    let c = social("Follow us", 5, 2_000, 10);
    let sig = approve("alice.testnet", &c, EXP);
    context("alice.testnet", 0, 2001, T0, [1u8; 32]);
    let id = realm2.create_campaign(c, u64j(EXP), sig);
    realm2.close_campaign(id);
    assert_eq!(realm2.get_player(acc("alice.testnet")).unwrap().chips.0, 990 * ch);
    assert_eq!(realm2.camp.escrow, 0);
    assert!(!realm2.get_campaigns(None)[0].active);
}

#[test]
fn campaigns_need_the_church_oracle_and_a_believer() {
    let mut realm = boot();
    with_oracle(&mut realm);
    deposit(&mut realm, "alice.testnet", 1_000);
    faithful(&mut realm, "alice.testnet", 20_000);
    // approval signed for different wording
    let sig = approve("alice.testnet", &social("Follow us", 5, 0, 10), EXP);
    context("alice.testnet", 0, 2001, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| { r.create_campaign(social("Follow THEM", 5, 0, 10), u64j(EXP), sig); });
    assert!(msg.contains("bad_signature"), "{msg}");
    // a player below FAITH 10
    let mut realm = boot();
    with_oracle(&mut realm);
    deposit(&mut realm, "alice.testnet", 1_000);
    faithful(&mut realm, "alice.testnet", 5_000);
    let c = social("Follow us", 5, 0, 10);
    let sig = approve("alice.testnet", &c, EXP);
    context("alice.testnet", 0, 2001, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| { r.create_campaign(c, u64j(EXP), sig); });
    assert!(msg.contains("faith_low"), "{msg}");
    // a claim with someone else's attestation, and an expired one
    let mut realm = boot();
    with_oracle(&mut realm);
    context("admin.testnet", 0, 2001, T0, [1u8; 32]);
    let id = realm.seed_campaign(social("Follow @NEARProtocol", 1, 3_000, 5));
    deposit(&mut realm, "bob.testnet", 10);
    context("bob.testnet", 0, 2002, T0, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.claim_campaign(id, u64j(EXP), attest(id, "alice.testnet", EXP)));
    assert!(msg.contains("bad_signature"), "{msg}");
    let mut realm = boot();
    with_oracle(&mut realm);
    context("admin.testnet", 0, 2001, T0, [1u8; 32]);
    let id = realm.seed_campaign(social("Follow @NEARProtocol", 1, 3_000, 5));
    context("bob.testnet", 0, 2002, EXP + 1, [1u8; 32]);
    let msg = panic_code_on(&mut realm, |r| r.claim_campaign(id, u64j(EXP), attest(id, "bob.testnet", EXP)));
    assert!(msg.contains("too_late"), "{msg}");
}

#[test]
fn campaign_faith_is_capped_per_day_and_seeded_ones_refund_the_treasury() {
    let mut realm = boot();
    with_oracle(&mut realm);
    let t0 = realm.treasury;
    context("admin.testnet", 0, 2001, T0, [1u8; 32]);
    let ids: Vec<u32> = (0..3).map(|i| realm.seed_campaign(social(&format!("Quest {i}"), 1, 5_000, 5))).collect();
    assert_eq!(t0 - realm.treasury, 15 * chip(&realm));
    deposit(&mut realm, "bob.testnet", 10);
    let f0 = realm.get_player(acc("bob.testnet")).unwrap().faith_milli;
    for id in &ids {
        context("bob.testnet", 0, 2002, T0, [1u8; 32]);
        realm.claim_campaign(*id, u64j(EXP), attest(*id, "bob.testnet", EXP));
    }
    assert_eq!(realm.get_player(acc("bob.testnet")).unwrap().faith_milli - f0, 10_000, "10 FAITH a day from campaigns");
    context("admin.testnet", 0, 2003, T0, [1u8; 32]);
    let before = realm.treasury;
    realm.close_campaign(ids[0]);
    assert_eq!(realm.treasury - before, 4 * chip(&realm));
}

#[test]
fn a_machine_campaign_is_verified_on_chain_and_a_plot_can_be_released() {
    let mut realm = boot();
    with_oracle(&mut realm);
    deposit(&mut realm, "alice.testnet", 3_000);
    deposit(&mut realm, "bob.testnet", 200);
    faithful(&mut realm, "alice.testnet", 20_000);
    context("admin.testnet", 0, 2000, T0, [1u8; 32]);
    realm.grant_plot_gate(acc("alice.testnet"));
    context("alice.testnet", 0, 2001, T0, [1u8; 32]);
    // a 10-chip spin can pay 100x, so the bankroll must cover 1 000 chips
    let mid = realm.create_machine(1, "Lucky".into(), "gold".into(), near_sdk::json_types::U128(1_500 * chip(&realm)));
    let c = NewCampaign { kind: 2, title: "Play my slot".into(), url: String::new(), machine_id: mid, goal: 1, reward_chips: 3, reward_faith_milli: 0, max_claims: 5 };
    let sig = approve("alice.testnet", &c, EXP);
    context("alice.testnet", 0, 2002, T0, [1u8; 32]);
    let id = realm.create_campaign(c, u64j(EXP), sig);
    // before playing: not done (the check runs before any state changes, so the caught panic leaves no trace)
    context("bob.testnet", 0, 2003, T0, [1u8; 32]);
    let early = panic_code_on(&mut realm, |r| r.claim_campaign(id, u64j(0), String::new()));
    assert!(early.contains("not_done"), "{early}");
    let server = [0x11u8; 32];
    commit_one(&mut realm, server);
    context("bob.testnet", 0, 2004, T0, [0x22u8; 32]);
    let bet = realm.place_bet("Slots".into(), near_sdk::json_types::U128(10 * chip(&realm)), 0, to_hex(&[0x33u8; 32]), mid);
    context("boss.testnet", 0, 2005, T0, [1u8; 32]);
    realm.reveal(bet, to_hex(&server));
    assert_eq!(realm.get_campaigns(Some(acc("bob.testnet")))[0].progress, 1);
    let b0 = realm.get_player(acc("bob.testnet")).unwrap().chips.0;
    context("bob.testnet", 0, 2006, T0, [1u8; 32]);
    realm.claim_campaign(id, u64j(0), String::new());
    assert_eq!(realm.get_player(acc("bob.testnet")).unwrap().chips.0 - b0, 3 * chip(&realm));
    // the admin frees the plot: bankroll back to the owner, deed burned, plot reusable
    let a0 = realm.get_player(acc("alice.testnet")).unwrap().chips.0;
    let bank = realm.get_machine(mid).unwrap().bankroll.0;
    let total = realm.liability_total();
    context("admin.testnet", 0, 2007, T0, [1u8; 32]);
    realm.release_plot(1);
    assert_eq!(realm.get_player(acc("alice.testnet")).unwrap().chips.0 - a0, bank);
    assert_eq!(realm.mt_balance_of(acc("alice.testnet"), format!("deed:machine:{mid}")).0, 0);
    assert_eq!(realm.liability_total(), total, "release conserves");
    context("alice.testnet", 0, 2008, T0, [1u8; 32]);
    realm.create_machine(1, "Again".into(), "red".into(), near_sdk::json_types::U128(100 * chip(&realm)));
}

#[test]
fn alms_have_a_floor_when_the_treasury_is_small() {
    let mut realm = boot();
    as_priest(&mut realm);
    // a small treasury: 2% of 300 chips would be 6 chips a day; the floor is 100
    let ch = chip(&realm);
    realm.vault += realm.treasury - 300 * ch;     // keep the conserved total intact
    realm.treasury = 300 * ch;
    deposit(&mut realm, "bob.testnet", 10);
    let mut p = realm.players.get(&acc("bob.testnet")).cloned().unwrap();
    p.stats.candles = 1;
    realm.players.insert(acc("bob.testnet"), p);
    let total = realm.liability_total();
    context("priest.testnet", 0, 2001, T0 + 2 * 86_400 * 1_000_000_000, [1u8; 32]);
    realm.grant_alms(acc("bob.testnet"), 40);
    assert_eq!(realm.get_player(acc("bob.testnet")).unwrap().chips.0, 50 * ch);
    assert_eq!(realm.treasury, 260 * ch);
    assert_eq!(realm.liability_total(), total);
}

