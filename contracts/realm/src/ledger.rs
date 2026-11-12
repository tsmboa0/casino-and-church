//! Chip ledger, commit pool, and bet settlement.
//!
//! House bets reserve `max_payout + timeout_penalty` against the vault, so a withheld max win
//! can still pay the penalty. Machine bets reserve `max_payout` against that machine; the penalty
//! still comes from the vault and is capped by what the vault can spare.

use near_sdk::{env, json_types::U128, AccountId, Gas, NearToken, Promise};

use crate::events::emit;
use crate::blackjack::BLACKJACK_COMMITS;
use crate::games::{blessing_bps, max_base_payout, parse_game, resolve, valid_pick, GameKind};
use crate::params::{
    AGENT_COOLDOWN_NS, JACKPOT_BPS, METER_MAX, PROTOCOL_BPS, RESULT_RING, TREASURY_BPS,
};
use crate::player::{
    add_luck, settle, sub_faith, sub_luck, Bet, Player, StoredResult,
};
use crate::rng::{commit_of, draws_of, reveal_hash, timeout_hash};
use crate::util::{apply_bps, from_hex_32, must, to_hex, whole_chips};
use crate::Realm;

const DAY_NS: u64 = 86_400 * 1_000_000_000;

fn random_32() -> [u8; 32] {
    let v = env::random_seed();
    let mut out = [0u8; 32];
    let n = v.len().min(32);
    out[..n].copy_from_slice(&v[..n]);
    out
}

fn commit_slots(game: &GameKind) -> u64 {
    if *game == GameKind::Blackjack { BLACKJACK_COMMITS } else { 1 }
}

pub(crate) fn result_key(account: &AccountId, bet_id: u64) -> String {
    format!("{account}:{bet_id}")
}

impl Realm {
    pub(crate) fn touch(&mut self, id: &AccountId) -> (Player, bool) {
        let now = env::block_timestamp();
        let decay = self.params.decay_per_min_milli;
        let window = self.params.max_decay_window_s;
        let (mut player, is_new) = match self.players.get(id).cloned() {
            Some(p) => (p, false),
            None => (Player::new(now), true),
        };
        settle(&mut player, now, decay, window);
        (player, is_new)
    }

    pub(crate) fn save(&mut self, id: AccountId, player: Player, is_new: bool) {
        if is_new {
            self.total_players = self.total_players.saturating_add(1);
        }
        self.players.insert(id, player);
    }

    pub(crate) fn credit(&mut self, player: &mut Player, amount: u128) {
        if amount == 0 {
            return;
        }
        player.chips = player.chips.checked_add(amount).expect("credit");
        self.chips_outstanding = self.chips_outstanding.checked_add(amount).expect("credit");
    }

    pub(crate) fn debit(&mut self, player: &mut Player, amount: u128) {
        must(player.chips >= amount, "no_chips");
        player.chips -= amount;
        self.chips_outstanding -= amount;
    }

    pub(crate) fn spend_vault(&mut self, amount: u128) {
        let free = self.vault.saturating_sub(self.reserved);
        must(amount <= free && amount <= self.vault, "vault_low");
        self.vault -= amount;
    }

    pub(crate) fn liability_total(&self) -> u128 {
        self.chips_outstanding
            .checked_add(self.vault)
            .and_then(|v| v.checked_add(self.treasury))
            .and_then(|v| v.checked_add(self.jackpot))
            .and_then(|v| v.checked_add(self.machine_bankroll_total))
            .and_then(|v| v.checked_add(self.camp.escrow))
            .expect("liability")
    }

    pub(crate) fn deposit_inner(&mut self) {
        self.assert_running();
        let amount = env::attached_deposit().as_yoctonear();
        must(amount >= self.params.chip_yocto, "bad_args");
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        self.credit(&mut player, amount);
        self.save(id.clone(), player, is_new);
        emit("deposit", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "amount": amount.to_string(),
        }));
    }

    pub(crate) fn withdraw_inner(&mut self, amount: u128) -> Promise {
        must(amount >= self.params.chip_yocto, "bad_args");
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        self.debit(&mut player, amount);
        self.save(id.clone(), player, is_new);
        Promise::new(id.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(20))
                .on_withdraw(id, U128(amount)),
        )
    }

    pub(crate) fn on_withdraw_inner(&mut self, player: AccountId, amount: u128) {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok();
        if ok {
            emit("withdraw", near_sdk::serde_json::json!({
                "account_id": player.to_string(),
                "amount": amount.to_string(),
            }));
        } else if let Some(mut existing) = self.players.get(&player).cloned() {
            self.credit(&mut existing, amount);
            self.players.insert(player, existing);
        }
    }

    pub(crate) fn claim_welcome_inner(&mut self) {
        self.assert_running();
        let id = env::predecessor_account_id();
        let chip = self.params.chip_yocto;
        let grant = u128::from(self.params.welcome_grant_chips) * chip;
        must(grant > 0, "bad_args");
        let (mut player, is_new) = self.touch(&id);
        must(!player.welcome_claimed, "welcome_claimed");
        let cap = u128::from(self.params.welcome_cap_total_chips).saturating_mul(chip);
        must(self.welcome_paid.saturating_add(grant) <= cap, "vault_low");
        self.spend_vault(grant);
        self.welcome_paid += grant;
        self.credit(&mut player, grant);
        player.welcome_claimed = true;
        self.save(id.clone(), player, is_new);
        emit("welcome_claimed", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "amount": grant.to_string(),
        }));
    }

    pub(crate) fn grant_promo_inner(&mut self, player_id: AccountId, chips: u32) {
        self.assert_running();
        let _admin = self.assert_agent();
        let chip = self.params.chip_yocto;
        let amount = u128::from(chips) * chip;
        must(amount > 0, "bad_args");
        let day = env::block_timestamp() / DAY_NS;
        if self.promo_day != day {
            self.promo_day = day;
            self.promo_spent = 0;
        }
        let day_cap = u128::from(self.params.promo_day_cap_chips).saturating_mul(chip);
        let player_cap = u128::from(self.params.promo_player_cap_chips).saturating_mul(chip);
        must(self.promo_spent.saturating_add(amount) <= day_cap, "bad_args");
        let (mut player, is_new) = self.touch(&player_id);
        if player.promo_day != day {
            player.promo_day = day;
            player.promo_today = 0;
        }
        must(player.promo_today.saturating_add(amount) <= player_cap, "bad_args");
        self.spend_vault(amount);
        self.promo_spent += amount;
        player.promo_today += amount;
        self.credit(&mut player, amount);
        self.save(player_id.clone(), player, is_new);
        emit("promo_granted", near_sdk::serde_json::json!({
            "account_id": player_id.to_string(),
            "amount": amount.to_string(),
        }));
    }

    pub(crate) fn seed_inner(&mut self, pool: &str) {
        self.assert_admin();
        self.assert_running();
        let amount = env::attached_deposit().as_yoctonear();
        must(amount > 0, "bad_args");
        match pool {
            "vault" => self.vault += amount,
            "treasury" => self.treasury += amount,
            "jackpot" => self.jackpot += amount,
            _ => must(false, "bad_args"),
        }
        emit("params_changed", near_sdk::serde_json::json!({
            "pool": pool,
            "amount": amount.to_string(),
        }));
    }

    pub(crate) fn commit_batch_inner(&mut self, commits: Vec<String>) {
        self.assert_dealer();
        self.assert_running();
        must(!commits.is_empty() && commits.len() <= 100, "bad_args");
        let from = self.commit_tail;
        for hex_commit in commits {
            let hash = from_hex_32(&hex_commit);
            must(hash.is_some(), "bad_args");
            self.commits.insert(self.commit_tail, hash.unwrap());
            self.commit_tail += 1;
        }
        emit("commits_added", near_sdk::serde_json::json!({
            "from": from.to_string(),
            "to": self.commit_tail.to_string(),
            "count": (self.commit_tail - from).to_string(),
        }));
    }

    pub(crate) fn place_bet_inner(
        &mut self,
        game_s: String,
        wager: u128,
        pick: u8,
        client_seed_hex: String,
        machine_id: u32,
    ) -> u64 {
        self.assert_running();
        let game = parse_game(&game_s);
        let client_seed = from_hex_32(&client_seed_hex);
        must(client_seed.is_some(), "bad_args");
        let client_seed = client_seed.unwrap();
        must(valid_pick(game, pick), "bad_pick");
        let machine = if machine_id == 0 { None } else { Some(machine_id) };
        if machine.is_some() {
            must(game == GameKind::Slots, "bad_args");
        }
        let meter = matches!(game, GameKind::Wheel | GameKind::Harmony);
        let chip = self.params.chip_yocto;
        if meter {
            must(wager == 0, "bad_wager");
        } else {
            let chips = whole_chips(wager, chip);
            must(wager == chips * chip && chips <= u128::from(u32::MAX), "bad_wager");
            must(self.params.allowed_wagers.contains(&(chips as u32)), "bad_wager");
            let free_chips = whole_chips(self.vault.saturating_sub(self.reserved), chip);
            let effective = free_chips / 200;
            must(chips >= 1 && chips <= u128::from(self.params.max_bet_chips) && chips <= effective, "max_bet");
        }
        must(self.commit_tail.saturating_sub(self.commit_head) >= commit_slots(&game), "dealer_offline");

        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        if game == GameKind::Wheel {
            must(player.luck_milli == METER_MAX, "luck_low");
        }
        if game == GameKind::Harmony {
            must(player.luck_milli >= 50_000, "luck_low");
            must(player.faith_milli >= 50_000, "faith_low");
            must(player.luck_milli >= self.params.harmony_cost_milli, "luck_low");
            must(player.faith_milli >= self.params.harmony_cost_milli, "faith_low");
            let ready = player.harmony_at_ns.saturating_add(self.params.harmony_cooldown_s.saturating_mul(1_000_000_000));
            must(env::block_timestamp() >= ready, "cooldown");
        }
        if !meter {
            must(player.chips >= wager, "no_chips");
        }
        if let Some(mid) = machine {
            must(self.machines.get(&mid).is_some(), "bad_args");
        }

        let max_payout = max_base_payout(game, wager, chip);
        let penalty = if meter { 0 } else { apply_bps(wager, u128::from(self.params.timeout_penalty_bps)) };
        let hold = if machine.is_some() { max_payout } else { max_payout.saturating_add(penalty) };

        let (treasury_part, jackpot_part, to_vault, to_bank) = if meter {
            (0, 0, 0, 0)
        } else {
            let t = apply_bps(wager, TREASURY_BPS);
            let j = apply_bps(wager, JACKPOT_BPS);
            if machine.is_some() {
                let fee = apply_bps(wager, PROTOCOL_BPS);
                (t, j, fee, wager - t - j - fee)
            } else {
                (t, j, wager - t - j, 0)
            }
        };

        if let Some(mid) = machine {
            let m = self.machines.get(&mid).cloned().expect("machine");
            must(m.bankroll + to_bank >= m.reserved + max_payout, "vault_low");
        } else {
            must(self.vault + to_vault >= self.reserved + hold, "vault_low");
        }

        if !meter {
            self.debit(&mut player, wager);
            self.treasury += treasury_part;
            self.jackpot += jackpot_part;
            self.vault += to_vault;
        }
        if let Some(mid) = machine {
            let mut m = self.machines.get(&mid).cloned().expect("machine");
            m.bankroll += to_bank;
            m.earned_net = m.earned_net.saturating_add(i128::try_from(to_bank).unwrap_or(i128::MAX));
            m.reserved += max_payout;
            self.machines.insert(mid, m);
            self.machine_bankroll_total += to_bank;
            self.machine_reserved += max_payout;
        } else {
            self.reserved += hold;
            if game == GameKind::Wheel {
                player.luck_milli = 0;
            } else if game == GameKind::Harmony {
                sub_luck(&mut player, self.params.harmony_cost_milli);
                sub_faith(&mut player, self.params.harmony_cost_milli);
                player.harmony_at_ns = env::block_timestamp();
            }
        }

        let bet_id = self.next_bet_id;
        self.next_bet_id += 1;
        let commit_idx = self.commit_head;
        self.commit_head += commit_slots(&game);
        let bet = Bet {
            player: id.clone(),
            game,
            machine_id: machine,
            wager,
            max_payout,
            hold,
            pick,
            client_seed,
            chain_seed: random_32(),
            commit_idx,
            placed_height: env::block_height(),
            placed_ns: env::block_timestamp(),
            blessing_bps: blessing_bps(player.faith_milli),
        };
        self.bets.insert(bet_id, bet);
        self.pending_bets += 1;
        self.save(id.clone(), player, is_new);
        emit("bet_placed", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "bet_id": bet_id.to_string(),
            "game": game_s,
            "wager": wager.to_string(),
            "commit_idx": commit_idx.to_string(),
            "placed_height": env::block_height().to_string(),
            "machine_id": machine_id,
        }));
        bet_id
    }

    pub(crate) fn reveal_inner(&mut self, bet_id: u64, server_seed_hex: String) {
        self.assert_dealer();
        self.assert_running();
        let server = from_hex_32(&server_seed_hex);
        must(server.is_some(), "bad_seed");
        let server = server.unwrap();
        let bet = self.bets.get(&bet_id).cloned();
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        must(bet.game != GameKind::Blackjack, "bad_args");
        let committed = self.commits.get(&bet.commit_idx).cloned();
        must(committed.is_some(), "bad_seed");
        must(committed.unwrap() == commit_of(&server), "bad_seed");
        let hash = reveal_hash(&server, &bet.client_seed, &bet.chain_seed, bet_id);
        self.settle_bet(bet_id, hash, server, [0u8; 32], false);
    }

    pub(crate) fn claim_timeout_inner(&mut self, bet_id: u64) {
        let bet = self.bets.get(&bet_id).cloned();
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        if bet.game == GameKind::Blackjack {
            self.blackjack_timeout_inner(bet_id);
            return;
        }
        let height = env::block_height();
        must(height >= bet.placed_height.saturating_add(self.params.reveal_timeout_blocks), "too_early");
        let block_seed = random_32();
        let hash = timeout_hash(&bet.client_seed, &bet.chain_seed, &block_seed, bet_id);
        self.settle_bet(bet_id, hash, [0u8; 32], block_seed, true);
    }

    fn settle_bet(&mut self, bet_id: u64, hash: [u8; 32], server_seed: [u8; 32], block_seed: [u8; 32], via_timeout: bool) {
        let bet = self.bets.remove(&bet_id);
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        self.commits.remove(&bet.commit_idx);
        self.pending_bets = self.pending_bets.saturating_sub(1);
        if let Some(mid) = bet.machine_id {
            self.machine_reserved = self.machine_reserved.saturating_sub(bet.hold);
            if let Some(mut machine) = self.machines.get(&mid).cloned() {
                machine.reserved = machine.reserved.saturating_sub(bet.hold);
                self.machines.insert(mid, machine);
            }
        } else {
            self.reserved = self.reserved.saturating_sub(bet.hold);
        }

        let draws = draws_of(&hash);
        let resolved = resolve(bet.game, &draws, bet.pick, bet.wager, self.params.chip_yocto);
        let chip = self.params.chip_yocto;
        let mut base_paid = resolved.base;
        let mut blessing = 0u128;

        if resolved.jackpot {
            let floor = 150 * chip;
            let pool = self.jackpot;
            self.jackpot = 0;
            base_paid = pool;
            if base_paid < floor {
                let need = floor - base_paid;
                let avail = self.vault.saturating_sub(self.reserved);
                let take = need.min(avail);
                self.vault -= take;
                base_paid += take;
            }
        } else if let Some(mid) = bet.machine_id {
            if let Some(mut machine) = self.machines.get(&mid).cloned() {
                let pay = resolved.base.min(machine.bankroll);
                machine.bankroll -= pay;
                machine.earned_net = machine.earned_net.saturating_sub(i128::try_from(pay).unwrap_or(i128::MAX));
                machine.plays = machine.plays.saturating_add(1);
                self.count_machine_play(mid, &bet.player);
                self.machine_bankroll_total = self.machine_bankroll_total.saturating_sub(pay);
                self.machines.insert(mid, machine);
                base_paid = pay;
            }
            blessing = self.take_blessing(base_paid, bet.blessing_bps);
        } else {
            let pay = resolved.base.min(self.vault);
            self.vault -= pay;
            base_paid = pay;
            blessing = self.take_blessing(base_paid, bet.blessing_bps);
        }

        let mut penalty = 0u128;
        if via_timeout && bet.wager > 0 {
            let want = apply_bps(bet.wager, u128::from(self.params.timeout_penalty_bps));
            let avail = self.vault.saturating_sub(self.reserved);
            penalty = want.min(avail);
            self.vault -= penalty;
        }

        let payout = base_paid + blessing + penalty;
        let (mut player, is_new) = self.touch(&bet.player);
        self.credit(&mut player, payout);
        let wager_chips = whole_chips(bet.wager, chip) as u32;
        let luck_gain = add_luck(&mut player, self.luck_award(wager_chips));
        match bet.game {
            GameKind::Slots => player.stats.spins = player.stats.spins.saturating_add(1),
            GameKind::Coin => player.stats.flips = player.stats.flips.saturating_add(1),
            GameKind::Dice => player.stats.dice = player.stats.dice.saturating_add(1),
            GameKind::Roulette => player.stats.roulette = player.stats.roulette.saturating_add(1),
            GameKind::Blackjack => player.stats.blackjack = player.stats.blackjack.saturating_add(1),
            GameKind::Wheel | GameKind::Harmony | GameKind::Market => {}
        }
        player.stats.wagered = player.stats.wagered.saturating_add(bet.wager);
        if via_timeout {
            player.stats.timeouts = player.stats.timeouts.saturating_add(1);
        }

        let stored = StoredResult {
            bet_id,
            game: bet.game,
            wager: bet.wager,
            payout,
            blessing,
            luck_gain_milli: luck_gain,
            reels: resolved.reels.clone(),
            side: resolved.side.clone(),
            dice: resolved.dice,
            n: resolved.n,
            color: resolved.color.clone(),
            prize_chips: resolved.prize_chips,
            jackpot: resolved.jackpot,
            server_seed,
            client_seed: bet.client_seed,
            chain_seed: bet.chain_seed,
            block_seed,
            settled_height: env::block_height(),
            via_timeout,
            dealer_cards: None,
            shoe: None,
        };
        self.push_result(&bet.player, &mut player, stored);
        self.save(bet.player.clone(), player, is_new);

        let via = if via_timeout { "timeout" } else { "reveal" };
        if via_timeout {
            emit("bet_timeout", near_sdk::serde_json::json!({
                "account_id": bet.player.to_string(),
                "bet_id": bet_id.to_string(),
                "penalty": penalty.to_string(),
            }));
        }
        emit("bet_settled", near_sdk::serde_json::json!({
            "account_id": bet.player.to_string(),
            "bet_id": bet_id.to_string(),
            "game": format!("{:?}", bet.game),
            "wager": bet.wager.to_string(),
            "payout": payout.to_string(),
            "blessing": blessing.to_string(),
            "luck_gain_milli": luck_gain,
            "server_seed": if via_timeout { String::new() } else { to_hex(&server_seed) },
            "client_seed": to_hex(&bet.client_seed),
            "chain_seed": to_hex(&bet.chain_seed),
            "block_seed": if via_timeout { to_hex(&block_seed) } else { String::new() },
            "via": via,
            "jackpot": resolved.jackpot,
            "prize_chips": resolved.prize_chips,
            "reels": resolved.reels,
            "side": resolved.side,
            "dice": resolved.dice,
            "n": resolved.n,
            "color": resolved.color,
        }));
    }

    /// Blackjack settlement. `base` is the chip payout before blessing. A timeout also pays the
    /// reserved penalty and does not take a blessing, so a stalled dealer cannot save the treasury.
    pub(crate) fn settle_blackjack(
        &mut self,
        bet_id: u64,
        base: u128,
        risked: u128,
        bless: bool,
        via_timeout: bool,
        player_cards: Vec<String>,
        dealer_cards: Vec<String>,
        player_total: u8,
        label: &str,
        shoe: Vec<[u8; 32]>,
    ) {
        let bet = self.bets.remove(&bet_id);
        must(bet.is_some(), "unknown_bet");
        let bet = bet.unwrap();
        self.bj.remove(&bet_id);
        for i in 0..BLACKJACK_COMMITS {
            self.commits.remove(&(bet.commit_idx + i));
        }
        self.pending_bets = self.pending_bets.saturating_sub(1);
        self.reserved = self.reserved.saturating_sub(bet.hold);

        let pay = base.min(self.vault);
        self.vault -= pay;
        let blessing = if bless { self.take_blessing(pay, bet.blessing_bps) } else { 0 };
        let mut penalty = 0u128;
        if via_timeout && bet.wager > 0 {
            let want = apply_bps(bet.wager, u128::from(self.params.timeout_penalty_bps));
            let avail = self.vault.saturating_sub(self.reserved);
            penalty = want.min(avail);
            self.vault -= penalty;
        }
        let payout = pay + blessing + penalty;
        let (mut player, is_new) = self.touch(&bet.player);
        self.credit(&mut player, payout);
        let chip = self.params.chip_yocto;
        let risked_chips = whole_chips(risked, chip) as u32;
        let luck_gain = add_luck(&mut player, self.luck_award(risked_chips));
        player.stats.blackjack = player.stats.blackjack.saturating_add(1);
        player.stats.wagered = player.stats.wagered.saturating_add(risked);
        if via_timeout {
            player.stats.timeouts = player.stats.timeouts.saturating_add(1);
        }
        let server_seed = shoe.first().copied().unwrap_or([0u8; 32]);
        let stored = StoredResult {
            bet_id,
            game: bet.game,
            wager: bet.wager,
            payout,
            blessing,
            luck_gain_milli: luck_gain,
            reels: Some(player_cards.clone()),
            side: Some(label.to_string()),
            dice: None,
            n: Some(player_total),
            color: None,
            prize_chips: None,
            jackpot: false,
            server_seed,
            client_seed: bet.client_seed,
            chain_seed: bet.chain_seed,
            block_seed: [0u8; 32],
            settled_height: env::block_height(),
            via_timeout,
            dealer_cards: Some(dealer_cards.clone()),
            shoe: if shoe.is_empty() { None } else { Some(shoe.clone()) },
        };
        self.push_result(&bet.player, &mut player, stored);
        self.save(bet.player.clone(), player, is_new);
        if via_timeout {
            emit("bet_timeout", near_sdk::serde_json::json!({
                "account_id": bet.player.to_string(),
                "bet_id": bet_id.to_string(),
                "penalty": penalty.to_string(),
            }));
        }
        emit("bet_settled", near_sdk::serde_json::json!({
            "account_id": bet.player.to_string(),
            "bet_id": bet_id.to_string(),
            "game": "Blackjack",
            "wager": bet.wager.to_string(),
            "payout": payout.to_string(),
            "blessing": blessing.to_string(),
            "luck_gain_milli": luck_gain,
            "server_seed": if via_timeout { String::new() } else { to_hex(&server_seed) },
            "client_seed": to_hex(&bet.client_seed),
            "chain_seed": to_hex(&bet.chain_seed),
            "via": if via_timeout { "timeout" } else { "reveal" },
            "reels": player_cards,
            "dealer_cards": dealer_cards,
            "side": label,
            "n": player_total,
            "shoe": shoe.iter().map(|seed| to_hex(seed)).collect::<Vec<_>>(),
        }));
    }

    pub(crate) fn take_blessing(&mut self, base: u128, bps: u16) -> u128 {
        if base == 0 || bps == 0 {
            return 0;
        }
        let chip = self.params.chip_yocto;
        let want_chips = whole_chips(base, chip) * u128::from(bps) / 10_000;
        if want_chips == 0 {
            return 0;
        }
        let day = env::block_timestamp() / DAY_NS;
        if day != self.blessing_day {
            self.blessing_day = day;
            self.blessing_spent = 0;
            self.blessing_cap = apply_bps(self.treasury, u128::from(self.params.blessing_day_cap_bps));
        }
        let room = self.blessing_cap.saturating_sub(self.blessing_spent);
        let give_chips = want_chips
            .min(whole_chips(room, chip))
            .min(whole_chips(self.treasury, chip));
        let yocto = give_chips * chip;
        self.treasury -= yocto;
        self.blessing_spent += yocto;
        yocto
    }

    pub(crate) fn push_result(&mut self, account: &AccountId, player: &mut Player, result: StoredResult) {
        let idx = player.recent_head as usize;
        let old = player.recent[idx];
        if old != 0 {
            self.results.remove(&result_key(account, old));
        }
        player.recent[idx] = result.bet_id;
        player.recent_head = ((idx + 1) % RESULT_RING) as u8;
        self.results.insert(result_key(account, result.bet_id), result);
    }

    pub(crate) fn set_params_inner(&mut self, patch: crate::params::ParamsPatch) {
        self.assert_running();
        must(!patch.is_empty(), "bad_args");
        let is_admin = self.assert_agent();
        if !is_admin {
            must(patch.agent_only(), "not_allowed");
            let now = env::block_timestamp();
            must(now >= self.last_agent_change_ns.saturating_add(AGENT_COOLDOWN_NS), "cooldown");
            if let Some(v) = patch.luck_per_chip_milli {
                must(crate::params::within_step(self.params.luck_per_chip_milli, v), "bad_args");
            }
            if let Some(v) = patch.max_bet_chips {
                must(crate::params::within_step(self.params.max_bet_chips, v), "bad_args");
            }
            self.last_agent_change_ns = now;
        }
        self.params.apply(&patch);
        emit("params_changed", near_sdk::serde_json::json!({
            "account_id": env::predecessor_account_id().to_string(),
            "max_bet_chips": self.params.max_bet_chips,
            "luck_per_chip_milli": self.params.luck_per_chip_milli,
        }));
    }
}
