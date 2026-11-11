//! Tithe, altar, candles, quests, realm presence, profile.

use near_sdk::env;

use crate::events::emit;
use crate::params::REALM_COOLDOWN_NS;
use crate::player::{add_faith, add_luck, parse_realm, sub_luck, valid_avatar, valid_name, RealmId};
use crate::util::must;
use crate::Realm;

impl Realm {
    pub(crate) fn set_profile_inner(&mut self, name: String, avatar: String) {
        self.assert_running();
        let name = name.trim();
        must(valid_name(name), "bad_name");
        must(valid_avatar(&avatar), "bad_name");
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        player.name = name.to_string();
        player.avatar = avatar;
        self.save(id.clone(), player, is_new);
        emit("profile_set", near_sdk::serde_json::json!({ "account_id": id.to_string() }));
    }

    pub(crate) fn enter_realm_inner(&mut self, realm_s: String) {
        self.assert_running();
        let realm = parse_realm(&realm_s);
        must(realm.is_some(), "bad_args");
        let realm = realm.unwrap();
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        if player.realm != realm {
            let now = env::block_timestamp();
            must(now >= player.last_realm_change_ns.saturating_add(REALM_COOLDOWN_NS), "rate_limited");
            player.realm = realm;
            player.last_realm_change_ns = now;
        }
        self.save(id.clone(), player, is_new);
        emit("realm_entered", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "realm": realm_s,
        }));
    }

    pub(crate) fn complete_tour_inner(&mut self, realm_s: String) {
        self.assert_running();
        let bit: u8 = match parse_realm(&realm_s) {
            Some(RealmId::Casino) => 0,
            Some(RealmId::Church) => 1,
            Some(RealmId::Plaza) => 2,
            None => {
                must(false, "bad_args");
                0
            }
        };
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        player.tour_flags |= 1 << bit;
        self.save(id, player, is_new);
    }

    /// Faith gained, in milli-units (the chain value; the UI divides by 1000).
    pub(crate) fn tithe_inner(&mut self, chips: u32) -> u32 {
        self.assert_running();
        must(chips >= 10, "bad_args");
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        let amount = u128::from(chips) * self.params.chip_yocto;
        self.debit(&mut player, amount);
        self.treasury += amount;
        let raw = (u128::from(chips) * 100 * (200_000 - u128::from(player.faith_milli)) / 200_000) as u32;
        let applied = add_faith(&mut player, self.faith_award(raw));
        player.stats.tithed = player.stats.tithed.saturating_add(amount);
        self.save(id.clone(), player, is_new);
        emit("tithe", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "chips": chips.to_string(),
            "amount": amount.to_string(),
            "faith_gain_milli": applied,
        }));
        applied
    }

    pub(crate) fn offer_luck_inner(&mut self, luck_milli: u32) -> u32 {
        self.assert_running();
        must(luck_milli >= 1_000, "luck_low");
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        must(player.luck_milli >= luck_milli, "luck_low");
        sub_luck(&mut player, luck_milli);
        let raw = (u128::from(luck_milli) * u128::from(self.params.offer_ratio_bps) / 10_000) as u32;
        let applied = add_faith(&mut player, raw);
        player.stats.converted_milli = player.stats.converted_milli.saturating_add(u64::from(luck_milli));
        self.save(id.clone(), player, is_new);
        emit("offering", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "luck_milli": luck_milli,
            "faith_gain_milli": applied,
        }));
        applied
    }

    pub(crate) fn light_candle_inner(&mut self) {
        self.assert_running();
        let id = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id);
        let now = env::block_timestamp();
        let ready = player.candle_at_ns.saturating_add(self.params.candle_cooldown_s.saturating_mul(1_000_000_000));
        must(now >= ready, "cooldown");
        player.candle_at_ns = now;
        player.stats.candles = player.stats.candles.saturating_add(1);
        let faith = self.candle_faith();
        add_faith(&mut player, faith);
        self.save(id.clone(), player, is_new);
        emit("candle", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "faith_gain_milli": faith,
        }));
    }

    pub(crate) fn claim_quest_inner(&mut self, quest_id: String) {
        self.assert_running();
        let id = env::predecessor_account_id();
        let chip = self.params.chip_yocto;
        let (mut player, is_new) = self.touch(&id);
        let (bit, ready, kind, amount) = match quest_id.as_str() {
            "q-spin" => (0u8, player.stats.spins >= 3, 0u8, 50u128),
            "q-flip" => (1, player.stats.flips >= 1, 0, 40),
            "q-tithe" => (2, player.stats.tithed >= 50 * chip, 1, 5_000),
            "q-candle" => (3, player.stats.candles >= 2, 2, 4_000),
            "q-altar" => (4, player.stats.converted_milli >= 20_000, 0, 100),
            _ => {
                must(false, "bad_args");
                (0, false, 0, 0)
            }
        };
        must(player.quests_claimed & (1u32 << bit) == 0, "bad_args");
        must(ready, "bad_args");
        player.quests_claimed |= 1u32 << bit;
        match kind {
            0 => {
                let yocto = amount * chip;
                self.spend_vault(yocto);
                self.credit(&mut player, yocto);
            }
            1 => {
                add_faith(&mut player, amount as u32);
            }
            _ => {
                add_luck(&mut player, amount as u32);
            }
        }
        self.save(id.clone(), player, is_new);
        emit("quest_claimed", near_sdk::serde_json::json!({
            "account_id": id.to_string(),
            "quest_id": quest_id,
        }));
    }
}
