//! Founders' plots. A machine is a slots bankroll. Wins are paid from it; the deed says who operates it.

use near_sdk::{env, AccountId};

use crate::events::emit;
use crate::player::{valid_name, valid_skin, Machine};
use crate::util::must;
use crate::Realm;

const MIN_BANKROLL_CHIPS: u128 = 100;
const RESERVE_CHIPS: u128 = 100;
const GATE_WAGERED_CHIPS: u128 = 100;
const GATE_FAITH_MILLI: u64 = 5_000;

impl Realm {
    pub(crate) fn machine_owner(&self, machine: &Machine) -> AccountId {
        let token = format!("deed:machine:{}", machine.id);
        self.mt.owners.get(&token).cloned().unwrap_or_else(|| machine.owner.clone())
    }

    pub(crate) fn grant_plot_gate_inner(&mut self, player_id: AccountId) {
        self.assert_admin();
        self.assert_running();
        let (mut player, is_new) = self.touch(&player_id);
        player.plot_gate = true;
        self.save(player_id, player, is_new);
    }

    pub(crate) fn release_plot_inner(&mut self, plot: u8) {
        self.assert_admin();
        let id = self.plots.get(&plot).copied().unwrap_or_else(|| env::panic_str("bad_args"));
        let machine = self.machines.get(&id).cloned().unwrap_or_else(|| env::panic_str("bad_args"));
        must(machine.reserved == 0, "reserve");
        let owner = self.machine_owner(&machine);
        let (mut p, is_new) = self.touch(&owner);
        self.machine_bankroll_total -= machine.bankroll;
        self.credit(&mut p, machine.bankroll);
        self.save(owner.clone(), p, is_new);
        self.machines.remove(&id);
        self.plots.remove(&plot);
        self.burn_deed(id, &owner);
        emit("plot_released", near_sdk::serde_json::json!({ "plot": plot, "machine_id": id, "refund": machine.bankroll.to_string() }));
    }

    pub(crate) fn create_machine_inner(&mut self, plot: u8, name: String, skin: String, bankroll: u128) -> u32 {
        self.assert_running();
        must((1..=3).contains(&plot), "bad_args");
        must(self.plots.get(&plot).is_none(), "plot_taken");
        let name = name.trim();
        must(valid_name(name), "bad_name");
        must(valid_skin(&skin), "bad_args");
        let chip = self.params.chip_yocto;
        must(bankroll >= MIN_BANKROLL_CHIPS * chip, "bankroll_low");
        let id_account = env::predecessor_account_id();
        let (mut player, is_new) = self.touch(&id_account);
        let gate = player.plot_gate
            || (player.stats.wagered >= GATE_WAGERED_CHIPS * chip && player.stats.faith_earned_milli >= GATE_FAITH_MILLI);
        must(gate, "plot_gate");
        self.debit(&mut player, bankroll);
        let id = self.next_machine_id;
        self.next_machine_id += 1;
        let machine = Machine {
            id,
            plot,
            owner: id_account.clone(),
            name: name.to_string(),
            skin: skin.clone(),
            bankroll,
            reserved: 0,
            plays: 0,
            earned_net: 0,
        };
        self.machines.insert(id, machine);
        self.plots.insert(plot, id);
        self.machine_bankroll_total += bankroll;
        self.mint_deed(id, &id_account);
        self.save(id_account.clone(), player, is_new);
        emit("machine_created", near_sdk::serde_json::json!({
            "account_id": id_account.to_string(),
            "machine_id": id,
            "plot": plot,
            "name": name,
            "skin": skin,
            "bankroll": bankroll.to_string(),
        }));
        id
    }

    pub(crate) fn fund_machine_inner(&mut self, id: u32, amount: u128) {
        self.assert_running();
        must(amount >= self.params.chip_yocto, "bad_args");
        let actor = env::predecessor_account_id();
        let machine = self.machines.get(&id).cloned();
        must(machine.is_some(), "bad_args");
        let mut machine = machine.unwrap();
        must(self.machine_owner(&machine) == actor, "not_owner");
        let (mut player, is_new) = self.touch(&actor);
        self.debit(&mut player, amount);
        machine.bankroll += amount;
        self.machine_bankroll_total += amount;
        self.machines.insert(id, machine);
        self.save(actor.clone(), player, is_new);
        emit("machine_funded", near_sdk::serde_json::json!({
            "account_id": actor.to_string(),
            "machine_id": id,
            "amount": amount.to_string(),
        }));
    }

    pub(crate) fn withdraw_machine_inner(&mut self, id: u32, amount: u128) {
        self.assert_running();
        must(amount >= self.params.chip_yocto, "bad_args");
        let actor = env::predecessor_account_id();
        let machine = self.machines.get(&id).cloned();
        must(machine.is_some(), "bad_args");
        let mut machine = machine.unwrap();
        must(self.machine_owner(&machine) == actor, "not_owner");
        let chip = self.params.chip_yocto;
        let keep = (RESERVE_CHIPS * chip).max(machine.reserved);
        must(machine.bankroll >= amount && machine.bankroll - amount >= keep, "reserve");
        machine.bankroll -= amount;
        self.machine_bankroll_total -= amount;
        self.machines.insert(id, machine);
        let (mut player, is_new) = self.touch(&actor);
        self.credit(&mut player, amount);
        self.save(actor.clone(), player, is_new);
        emit("machine_withdrawn", near_sdk::serde_json::json!({
            "account_id": actor.to_string(),
            "machine_id": id,
            "amount": amount.to_string(),
        }));
    }
}
