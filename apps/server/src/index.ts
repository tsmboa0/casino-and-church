import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';

/** `.env` then `.env.local`, from the repo root and the server directory. Process env wins. */
function loadEnvFiles() {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [resolve(here, '../../..'), resolve(here, '../..'), process.cwd()];
  for (const root of roots) {
    for (const name of ['.env', '.env.local']) {
      const path = resolve(root, name);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
  }
}

loadEnvFiles();
import { buildApp } from './api/app.ts';
import { MemoryStore } from './db/memory.ts';
import { PostgresStore } from './db/postgres.ts';
import { Hub } from './indexer/hub.ts';
import { NearRpc } from './near/rpc.ts';
import { KeyPool } from './near/pool.ts';
import { Dealer } from './dealer/dealer.ts';
import { MarketKeeper } from './market/keeper.ts';
import { Hosts } from './agent/service.ts';
import { Activity } from './agent/activity.ts';
import type { Store } from './db/store.ts';

const config = loadConfig();
const hub = new Hub();
const rpc = new NearRpc(config.rpcUrl, config.contract);

let store: Store;
if (config.databaseUrl) store = await PostgresStore.connect(config.databaseUrl);
else store = new MemoryStore();

if (config.dealerKeys.length && config.contract && !config.databaseUrl) {
  throw new Error('Refusing to run the dealer against a live contract without DATABASE_URL.');
}

const relayer = config.relayerKeys.length
  ? new KeyPool(rpc, config.relayerAccount, config.contract, config.relayerKeys)
  : null;
const dealerPool = config.dealerKeys.length
  ? new KeyPool(rpc, config.dealerAccount, config.contract, config.dealerKeys)
  : null;

// Don Fortuna decides as the dealer account but with his own keys: the dealer keys only allow the dealer's methods.
// Father Nakamoto signs with his own account's keys. scripts/host-keys.mjs sets both up.
const agentPool = config.agentKeys.length && config.dealerAccount
  ? new KeyPool(rpc, config.dealerAccount, config.contract, config.agentKeys)
  : dealerPool;
const priestPool = config.priestKeys.length && config.priestAccount
  ? new KeyPool(rpc, config.priestAccount, config.contract, config.priestKeys)
  : null;
const activity = new Activity();
let agents: Hosts | undefined;

let dealer: Dealer | undefined;
let market: MarketKeeper | undefined;
if (dealerPool && config.dealerEncKey && config.contract) {
  const locked = await store.tryDealerLock();
  if (!locked) {
    console.error(JSON.stringify({ at: 'boot', error: 'dealer lock is held by another process' }));
  } else {
    const key = Buffer.from(config.dealerEncKey, 'hex');
    if (key.length !== 32) throw new Error('DEALER_ENC_KEY must be 64 hex characters (32 bytes).');
    dealer = new Dealer(rpc, dealerPool, store, hub, key);
    dealer.start();
    // the hosts run in the process that holds the dealer lock, so two servers never decide twice
    agents = new Hosts(config, rpc, store, hub, activity, { fortuna: agentPool, nakamoto: priestPool });
    agents.start();
    // the BTC market keeper also runs only here (one process requests prices). Without its keys the market is
    // still shown (the snapshot), it just cannot be priced from this server.
    const keeperPool = config.marketKeeperKeys.length && config.marketKeeperAccount
      ? new KeyPool(rpc, config.marketKeeperAccount, config.contract, config.marketKeeperKeys)
      : null;
    market = new MarketKeeper(rpc, keeperPool, store, hub);
    market.start();
  }
}

const app = buildApp({
  config,
  store,
  hub,
  dealer,
  market,
  agents,
  activity,
  rpcCall: (method, params) => rpc.call(method, params),
  // the provider only (e.g. quiknode.pro): RPC URLs carry their API key in the path or the query
  rpcEndpoint: () => { try { return new URL(rpc.endpoint).hostname.split('.').slice(-2).join('.'); } catch { return 'hidden'; } },
  height: async () => (await rpc.recentTip()).height,   // a 15 s-old tip is fine for the expiry window check
  broadcast: (signed) => {
    if (!relayer) return Promise.reject(new Error('relayer keys are not configured'));
    return relayer.submitDelegate(signed);
  },
  transfer: relayer ? (to, yocto) => relayer.transfer(to, yocto) : undefined,
  view: config.contract ? (method, args) => rpc.view(method, args) : undefined,
  balance: (account) => rpc.balance(account),
  lag: async () => {
    const finalTip = await rpc.tip('final');
    const live = await rpc.tip('optimistic');
    return Number(live.height - finalTip.height);
  },
});

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(JSON.stringify({
  at: 'boot', port: config.port, contract: config.contract || null, dealer: Boolean(dealer), rpc: rpc.endpoint.replace(/\?.*$/, ''),
  hosts: agents ? { model: agents.ai?.model ?? 'rules only', donKeys: config.agentKeys.length ? 'own' : 'dealer (may lack host_act)', priest: Boolean(priestPool), disabled: config.agentsDisabled } : null,
}));
