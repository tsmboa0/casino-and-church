//! BTC UP/DOWN market: rounds, the OutLayer price callback, payouts, voids, and the money invariant.

use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult};

use crate::market::{parse_oracle, MarketConfig};
use crate::Realm;

const T0: u64 = 1_800_000_000 * 1_000_000_000;
const S: u64 = 1_000_000_000;
const FEE: u128 = 20_000_000_000_000_000_000_000;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(pred: &str, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("realm.testnet"))
        .signer_account_id(acc(pred))
        .predecessor_account_id(acc(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50_000))
        .block_height(100 + ts / S % 100_000)
        .block_timestamp(ts)
        .prepaid_gas(Gas::from_tgas(300))
        .random_seed([3u8; 32]);
    testing_env!(b.build());
}

/// the private price callback, with OutLayer's reply as the promise result
fn callback(realm: &mut Realm, ts: u64, epoch: u64, requested_ns: u64, reply: Option<Vec<u8>>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("realm.testnet"))
        .predecessor_account_id(acc("realm.testnet"))
        .signer_account_id(acc("boss.testnet"))
        .block_timestamp(ts)
        .account_balance(NearToken::from_near(50_000))
        .prepaid_gas(Gas::from_tgas(80));
    let result = match reply { Some(bytes) => PromiseResult::Successful(bytes), None => PromiseResult::Failed };
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), std::collections::HashMap::new(), vec![result]);
    realm.on_market_price(epoch, near_sdk::json_types::U64(requested_ns));
}

fn reply(price: f64, ts_s: u64) -> Vec<u8> {
    format!(r#"{{"prices":[{{"from_cache":false,"price":{price},"sources":["binance","kucoin","gate","huobi","cryptocom"],"timestamp":{ts_s},"token":"nbtc.bridge.near"}}],"success":true}}"#).into_bytes()
}

fn boot() -> Realm {
    ctx("admin.testnet", 0, T0);
    let mut realm = Realm::new(acc("admin.testnet"), acc("boss.testnet"), acc("agent.testnet"), None, None);
    ctx("admin.testnet", 2_000 * 10u128.pow(24), T0);
    realm.seed_vault();
    ctx("admin.testnet", 0, T0);
    realm.market_configure(MarketConfig { enabled: Some(true), ..Default::default() });
    for who in ["alice.testnet", "bob.testnet", "carol.testnet"] {
        ctx(who, 100 * realm.params.chip_yocto, T0);
        realm.deposit();
    }
    realm
}

fn chip(r: &Realm) -> u128 {
    r.params.chip_yocto
}

fn chips_of(r: &Realm, who: &str) -> u128 {
    r.players.get(&acc(who)).map(|p| p.chips).unwrap_or(0) / chip(r)
}

fn bet(r: &mut Realm, who: &str, ts: u64, side: &str, chips: u128) -> u64 {
    ctx(who, 0, ts);
    let epoch = r.market.epoch.max(1);
    r.market_bet(epoch, side.into(), U128(chips * chip(r)))
}

/// dealer tick at `ts` and the oracle answering `price` a few seconds later
fn tick_and_price(r: &mut Realm, ts: u64, price: f64) {
    ctx("boss.testnet", FEE, ts);
    let epoch = r.market.epoch;
    let _ = r.market_tick();
    assert_eq!(r.market.pending_epoch, epoch, "a price request is in flight");
    callback(r, ts + 8 * S, epoch, ts, Some(reply(price, ts / S + 3)));
    assert_eq!(r.market.pending_epoch, 0);
}

fn err<F: FnOnce(&mut Realm)>(r: &mut Realm, f: F) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(r))) {
        Ok(_) => panic!("expected a panic"),
        Err(e) => {
            let text = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            // the mock wraps the code: ... GuestPanic { panic_msg: "code" }
            match text.split("panic_msg: \"").nth(1) {
                Some(rest) => rest.split('"').next().unwrap_or("").to_string(),
                None => text,
            }
        }
    }
}

/// every chip is somewhere: players + vault + treasury + jackpot never change without a deposit or withdrawal
fn total(r: &Realm) -> u128 {
    r.liability_total()
}

#[test]
fn a_full_round_pays_the_right_side_and_conserves_every_chip() {
    let mut r = boot();
    let before = total(&r);
    let id_a = bet(&mut r, "alice.testnet", T0 + S, "up", 5);
    let _ = bet(&mut r, "bob.testnet", T0 + 2 * S, "down", 2);
    assert_eq!(chips_of(&r, "alice.testnet"), 95);
    assert_eq!(chips_of(&r, "bob.testnet"), 98);
    let hold = (5 + 2) * chip(&r) * 19 / 10;
    assert_eq!(r.reserved, hold, "both possible payouts are reserved");
    assert_eq!(total(&r), before);

    // round 1 locks at 73,500.00; round 2 opens
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    tick_and_price(&mut r, lock1 + 2 * S, 73_500.0);
    let round1 = r.market.rounds.get(&1).unwrap().clone();
    assert_eq!(round1.phase, crate::market::Phase::Live);
    assert_eq!(round1.lock_price, 7_350_000);
    assert_eq!(r.market.epoch, 2);

    // carol bets on round 2 while round 1 is live
    let _ = bet(&mut r, "carol.testnet", lock1 + 15 * S, "down", 1);
    // round 2's lock: BTC is up, so round 1 closes UP; round 2 locks at the same price
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    tick_and_price(&mut r, lock2 + S, 73_512.34);
    let round1 = r.market.rounds.get(&1).unwrap().clone();
    assert_eq!(round1.phase, crate::market::Phase::Closed);
    assert_eq!(round1.close_price, 7_351_234);
    assert_eq!(round1.settled, 2, "both bets paid inside the callback");
    assert_eq!(chips_of(&r, "alice.testnet"), 95 + 9, "5 chips at 1.9x = 9.5, whole chips shown");
    assert_eq!(r.players.get(&acc("alice.testnet")).unwrap().chips, 95 * chip(&r) + 5 * chip(&r) * 19 / 10);
    assert_eq!(chips_of(&r, "bob.testnet"), 98, "bob lost his 2");
    assert_eq!(r.market.rounds.get(&2).unwrap().lock_price, 7_351_234);
    assert_eq!(r.reserved, chip(&r) * 19 / 10, "only carol's bet is still held");
    assert_eq!(total(&r), before, "no chip created or lost");

    // alice's result is in her history like any other game
    let res = r.get_bet_result(acc("alice.testnet"), id_a).expect("result stored");
    assert_eq!(format!("{:?}", res.game), "Market");
    assert_eq!(res.outcome.side.as_deref(), Some("up"));
    assert_eq!(res.outcome.color.as_deref(), Some("up"));
    assert_eq!(res.outcome.reels.clone().unwrap(), vec!["73500.00".to_string(), "73512.34".to_string()]);
    assert!(res.luck_gain_milli > 0, "a decided bet earns LUCK");
}

#[test]
fn a_tie_refunds_both_sides() {
    let mut r = boot();
    let before = total(&r);
    bet(&mut r, "alice.testnet", T0 + S, "up", 2);
    bet(&mut r, "bob.testnet", T0 + S, "down", 2);
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    tick_and_price(&mut r, lock1 + S, 70_000.0);
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    tick_and_price(&mut r, lock2 + S, 70_000.004); // rounds to the same cent
    assert_eq!(chips_of(&r, "alice.testnet"), 100);
    assert_eq!(chips_of(&r, "bob.testnet"), 100);
    assert_eq!(r.reserved, 0);
    assert_eq!(total(&r), before);
}

#[test]
fn a_late_price_voids_the_rounds_and_anyone_can_trigger_it() {
    let mut r = boot();
    let before = total(&r);
    bet(&mut r, "alice.testnet", T0 + S, "up", 5);
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    tick_and_price(&mut r, lock1 + S, 70_000.0);
    bet(&mut r, "bob.testnet", lock1 + 20 * S, "down", 2);
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    // the dealer is gone for longer than the grace period; carol (a player) unsticks the market
    ctx("carol.testnet", 0, lock2 + 60 * S);
    let _ = r.market_tick();
    assert_eq!(r.market.rounds.get(&1).unwrap().phase, crate::market::Phase::Void);
    assert_eq!(r.market.rounds.get(&2).unwrap().phase, crate::market::Phase::Void);
    assert_eq!(r.market.epoch, 3, "a fresh round is open");
    assert_eq!(chips_of(&r, "alice.testnet"), 100, "refunded");
    assert_eq!(chips_of(&r, "bob.testnet"), 100, "refunded");
    assert_eq!(r.reserved, 0);
    assert_eq!(total(&r), before);
    // a void round earns no LUCK
    assert_eq!(r.players.get(&acc("alice.testnet")).unwrap().luck_milli, 0);
}

#[test]
fn a_bad_oracle_reply_changes_nothing_and_the_dealer_can_retry() {
    let mut r = boot();
    bet(&mut r, "alice.testnet", T0 + S, "up", 1);
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    let bad: Vec<Option<Vec<u8>>> = vec![
        None,                                                       // OutLayer failed
        Some(b"not json".to_vec()),
        Some(reply(73_000.0, lock1 / S - 120)),                     // stale exchange data
        Some(br#"{"prices":[{"price":1.0,"sources":["a","b","c"],"timestamp":0,"token":"wrap.near"}],"success":true}"#.to_vec()),
        Some(br#"{"prices":[],"success":false}"#.to_vec()),
    ];
    let n = bad.len() as u64;
    for (i, b) in bad.into_iter().enumerate() {
        let t = lock1 + (i as u64 + 1) * S;
        ctx("boss.testnet", FEE, t);
        let _ = r.market_tick();
        callback(&mut r, t + S, 1, t, b);
        assert_eq!(r.market.pending_epoch, 0, "the failure clears the request");
        assert_eq!(r.market.epoch, 1, "nothing moved");
        assert_eq!(r.market.rounds.get(&1).unwrap().phase, crate::market::Phase::Open);
    }
    assert_eq!(r.market.failures, n);
    assert!(get_logs().iter().any(|l| l.contains("market_price_failed")));
    tick_and_price(&mut r, lock1 + 30 * S, 73_000.0);
    assert_eq!(r.market.rounds.get(&1).unwrap().lock_price, 7_300_000);
}

#[test]
fn bet_rules() {
    let mut r = boot();
    // only on the open round, one bet per round, listed wagers only, enough chips
    assert_eq!(err(&mut r, |r| { ctx("alice.testnet", 0, T0 + S); r.market_bet(2, "up".into(), U128(chip(r))); }), "round_moved");
    assert_eq!(err(&mut r, |r| { ctx("alice.testnet", 0, T0 + S); r.market_bet(1, "sideways".into(), U128(chip(r))); }), "bad_pick");
    assert_eq!(err(&mut r, |r| { ctx("alice.testnet", 0, T0 + S); r.market_bet(1, "up".into(), U128(3 * chip(r))); }), "bad_wager");
    assert_eq!(err(&mut r, |r| { ctx("alice.testnet", 0, T0 + S); r.market_bet(1, "up".into(), U128(chip(r) / 2)); }), "bad_wager");
    assert_eq!(err(&mut r, |r| { ctx("dave.testnet", 0, T0 + S); r.market_bet(1, "up".into(), U128(chip(r))); }), "no_chips");
    bet(&mut r, "alice.testnet", T0 + S, "up", 1);
    assert_eq!(err(&mut r, |r| { ctx("alice.testnet", 0, T0 + 2 * S); r.market_bet(1, "down".into(), U128(chip(r))); }), "already_bet");
    // ticks: not before the lock, only the dealer prices, the fee must be attached
    assert_eq!(err(&mut r, |r| { ctx("boss.testnet", FEE, T0 + 10 * S); let _ = r.market_tick(); }), "too_early");
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    assert_eq!(err(&mut r, |r| { ctx("bob.testnet", FEE, lock1 + S); let _ = r.market_tick(); }), "not_allowed");
    assert_eq!(err(&mut r, |r| { ctx("boss.testnet", FEE / 2, lock1 + S); let _ = r.market_tick(); }), "bad_args");
    // after the lock time a bet is refused until the price comes
    assert_eq!(err(&mut r, |r| { ctx("bob.testnet", 0, lock1 + S); r.market_bet(1, "up".into(), U128(chip(r))); }), "round_locked");
    // one request at a time
    ctx("boss.testnet", FEE, lock1 + 2 * S);
    let _ = r.market_tick();
    assert_eq!(err(&mut r, |r| { ctx("boss.testnet", FEE, lock1 + 3 * S); let _ = r.market_tick(); }), "market_busy");
}

#[test]
fn an_idle_market_costs_nothing_and_the_first_bet_opens_a_full_window() {
    let mut r = boot();
    // nobody bets: there is nothing to price
    assert_eq!(err(&mut r, |r| { ctx("boss.testnet", FEE, T0 + 5 * S); let _ = r.market_tick(); }), "nothing_due");
    bet(&mut r, "alice.testnet", T0 + S, "up", 1);
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    tick_and_price(&mut r, lock1 + S, 70_000.0);
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    tick_and_price(&mut r, lock2 + S, 70_100.0); // round 1 closes UP; round 2 (empty) goes live
    assert_eq!(r.market.epoch, 3);
    // an hour later round 3 is long past its lock with nothing at stake: no tick is due
    let later = lock2 + 3_600 * S;
    ctx("bob.testnet", 0, later);
    assert!(!r.get_market(None).due);
    // bob's bet restarts round 3 with a full 60 s window and closes the empty live round
    bet(&mut r, "bob.testnet", later, "down", 2);
    let r3 = r.market.rounds.get(&3).unwrap().clone();
    assert_eq!(r3.open_ns, later);
    assert_eq!(r3.lock_ns, later + 60 * S);
    assert_eq!(r.market.rounds.get(&2).unwrap().phase, crate::market::Phase::Closed);
}

#[test]
fn the_view_shows_rounds_bets_and_due() {
    let mut r = boot();
    bet(&mut r, "alice.testnet", T0 + S, "down", 2);
    ctx("alice.testnet", 0, T0 + 2 * S);
    let v = r.get_market(Some(acc("alice.testnet")));
    assert!(v.enabled && !v.due && !v.pending);
    assert_eq!(v.open.as_ref().unwrap().bets, 1);
    assert_eq!(v.mine.len(), 1);
    assert_eq!(v.mine[0].side, "down");
    bet(&mut r, "bob.testnet", T0 + 3 * S, "up", 1);
    ctx("alice.testnet", 0, T0 + 4 * S);
    let list = r.get_market_bets(1, None, None);
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].player.as_str(), list[0].side.as_str()), ("alice.testnet", "down"));
    assert_eq!((list[1].player.as_str(), list[1].side.as_str()), ("bob.testnet", "up"));
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    ctx("alice.testnet", 0, lock1);
    assert!(r.get_market(None).due, "the dealer should tick now");
    tick_and_price(&mut r, lock1 + S, 70_000.0);
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    tick_and_price(&mut r, lock2 + S, 69_000.0);
    ctx("alice.testnet", 0, lock2 + 10 * S);
    let v = r.get_market(Some(acc("alice.testnet")));
    assert_eq!(v.recent[0].epoch, 1);
    assert_eq!(v.recent[0].outcome, "down");
    assert!(v.mine.is_empty(), "settled bets leave `mine` (they are in the results)");
    assert!(r.get_market_bets(1, None, None).is_empty(), "paid bets leave the round list");
    assert_eq!(v.last_price, 6_900_000);
}

#[test]
fn oracle_parsing() {
    let now = 1_800_000_000 * S;
    assert_eq!(parse_oracle(&reply(73_512.426_666, 1_800_000_003), "nbtc.bridge.near", now), Ok((7_351_243, 1_800_000_003)));
    assert_eq!(parse_oracle(&reply(1.0, 1_800_000_003), "wrap.near", now), Err("oracle_no_token"));
    assert_eq!(parse_oracle(&reply(1.0, 1_800_000_000 - 30), "nbtc.bridge.near", now), Err("oracle_stale"));
    assert_eq!(parse_oracle(&reply(1.0, 1_800_000_000 + 400), "nbtc.bridge.near", now), Err("oracle_stale"));
    assert_eq!(parse_oracle(&reply(-5.0, 1_800_000_003), "nbtc.bridge.near", now), Err("oracle_bad_price"));
    let two = br#"{"prices":[{"price":70000.0,"sources":["a","b"],"timestamp":1800000003,"token":"nbtc.bridge.near"}],"success":true}"#;
    assert_eq!(parse_oracle(two, "nbtc.bridge.near", now), Err("oracle_few_sources"));
}

#[test]
fn only_the_admin_configures_and_values_are_bounded() {
    let mut r = boot();
    assert_eq!(err(&mut r, |r| { ctx("boss.testnet", 0, T0); r.market_configure(MarketConfig { payout_bps: Some(19_000), ..Default::default() }); }), "not_allowed");
    let mut r = boot();
    assert_eq!(err(&mut r, |r| { ctx("admin.testnet", 0, T0); r.market_configure(MarketConfig { payout_bps: Some(25_000), ..Default::default() }); }), "bad_args");
    let mut r = boot();
    assert_eq!(err(&mut r, |r| { ctx("admin.testnet", 0, T0); r.market_configure(MarketConfig { source: Some("nope".into()), ..Default::default() }); }), "bad_args");
    let mut r = boot();
    ctx("admin.testnet", 0, T0);
    r.market_configure(MarketConfig { enabled: Some(false), ..Default::default() });
    assert_eq!(err(&mut r, |r| { ctx("alice.testnet", 0, T0 + S); r.market_bet(1, "up".into(), U128(chip(r))); }), "market_closed");
}

#[test]
fn many_bets_settle_in_batches() {
    let mut r = boot();
    let before = total(&r);
    let names: Vec<String> = (0..25).map(|i| format!("p{i}.testnet")).collect();
    for n in &names {
        ctx(n, 10 * chip(&r), T0);
        r.deposit();
    }
    let before = before + 25 * 10 * chip(&r);
    for (i, n) in names.iter().enumerate() {
        bet(&mut r, n, T0 + S, if i % 2 == 0 { "up" } else { "down" }, 1);
    }
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    tick_and_price(&mut r, lock1 + S, 70_000.0);
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    tick_and_price(&mut r, lock2 + S, 70_001.0);
    assert_eq!(r.market.rounds.get(&1).unwrap().settled, 10, "the callback pays the first ten");
    ctx("anyone.testnet", 0, lock2 + 20 * S);
    assert_eq!(r.market_settle(40), 15);
    assert!(r.market.queue.is_empty());
    assert_eq!(r.reserved, 0);
    let winners = names.iter().enumerate().filter(|(i, _)| i % 2 == 0).count() as u128;
    for (i, n) in names.iter().enumerate() {
        let c = r.players.get(&acc(n)).unwrap().chips;
        if i % 2 == 0 { assert_eq!(c, 9 * chip(&r) + chip(&r) * 19 / 10) } else { assert_eq!(c, 9 * chip(&r)) }
    }
    assert_eq!(winners, 13);
    assert_eq!(total(&r), before);
}

#[test]
fn v3_state_migrates_with_an_empty_market() {
    use near_sdk::borsh;
    let r = boot();
    let full = borsh::to_vec(&r).unwrap();
    let market_len = borsh::to_vec(&crate::market::MarketState::new()).unwrap().len();
    // a v3 contract is exactly today's bytes without the market block at the end
    let mut v3_realm = boot();
    v3_realm.market = crate::market::MarketState::new();
    let v4 = borsh::to_vec(&v3_realm).unwrap();
    let v3 = &v4[..v4.len() - market_len];
    ctx("realm.testnet", 0, T0);
    let up = crate::migrate_bytes(v3, None);
    assert!(!up.market.enabled);
    assert_eq!(up.market.epoch, 0);
    assert_eq!(up.vault, r.vault);
    assert_eq!(up.liability_total(), v3_realm.liability_total());
    assert!(full.len() >= v4.len());
}

#[test]
fn a_configured_keeper_may_request_prices() {
    let mut r = boot();
    ctx("admin.testnet", 0, T0);
    r.market_configure(MarketConfig { keeper: Some("keeper.testnet".into()), ..Default::default() });
    bet(&mut r, "alice.testnet", T0 + S, "up", 1);
    let lock1 = r.market.rounds.get(&1).unwrap().lock_ns;
    ctx("keeper.testnet", FEE, lock1 + S);
    let _ = r.market_tick();
    assert_eq!(r.market.pending_epoch, 1);
    callback(&mut r, lock1 + 9 * S, 1, lock1 + S, Some(reply(70_000.0, lock1 / S + 4)));
    assert_eq!(r.market.rounds.get(&1).unwrap().lock_price, 7_000_000);
    // removing the keeper takes the right away again
    ctx("admin.testnet", 0, lock1 + 10 * S);
    r.market_configure(MarketConfig { keeper: Some(String::new()), ..Default::default() });
    let lock2 = r.market.rounds.get(&2).unwrap().lock_ns;
    assert_eq!(err(&mut r, |r| { ctx("keeper.testnet", FEE, lock2 + S); let _ = r.market_tick(); }), "not_allowed");
}
