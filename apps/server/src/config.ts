export interface Config {
  port: number;
  network: string;
  rpcUrl: string;
  contract: string;
  relayerAccount: string;
  relayerKeys: string[];
  dealerAccount: string;
  dealerKeys: string[];
  dealerEncKey: string;
  databaseUrl: string;
  clientOrigin: string;
  relayDisabled: boolean;
  /** YoctoNEAR sent to create an implicit account. 0.05 NEAR. */
  accountCreateYocto: bigint;
  /** YoctoNEAR per faucet grant. 5 NEAR. */
  faucetYocto: bigint;
  accountHour: number;
  accountDay: number;
  ipHour: number;
  placeBetMs: number;
  dailyGasTgas: number;
  accountsPerIpDay: number;
  accountsTotal: number;
  faucetPerIpDay: number;
  /** Don Fortuna's decision keys on DEALER_ACCOUNT (scripts/host-keys.mjs). Empty = reuse the dealer keys. */
  agentKeys: string[];
  /** Father Nakamoto (Church host). Function-call keys on this account sign his decisions. */
  priestAccount: string;
  priestKeys: string[];
  nearaiKey: string;
  /** the Church oracle's ed25519 seed (hex); its public key is the contract's oracle_pk */
  oracleSecret: string;
  nearaiBase: string;
  nearaiModel: string;
  /** Total NEAR AI tokens per UTC day across decisions and chat. Above it the hosts use the rule policy and the FAQ. */
  nearaiDailyTokens: number;
  /** Share of the daily tokens chat may use (0..1). */
  chatTokenShare: number;
  agentsDisabled: boolean;
  /** Minutes between scheduled host decisions (spec: 10). */
  agentEveryMin: number;
  askPerAccountHour: number;
  askPerIpHour: number;
  /** browser RPC calls through /rpc per IP per hour (a whole venue may share one address) */
  rpcPerIpHour: number;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    network: env.NEAR_NETWORK ?? 'testnet',
    rpcUrl: env.NEAR_RPC_URL || 'https://near-testnet.drpc.org',   // may be a comma-separated failover list
    contract: env.REALM_CONTRACT ?? '',
    relayerAccount: env.RELAYER_ACCOUNT ?? '',
    relayerKeys: list(env.RELAYER_KEYS),
    dealerAccount: env.DEALER_ACCOUNT ?? '',
    dealerKeys: list(env.DEALER_KEYS),
    dealerEncKey: env.DEALER_ENC_KEY ?? '',
    databaseUrl: env.DATABASE_URL ?? '',
    clientOrigin: env.CLIENT_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173',
    relayDisabled: env.RELAY_DISABLED === '1',
    accountCreateYocto: BigInt(env.ACCOUNT_CREATE_YOCTO ?? '50000000000000000000000'),
    faucetYocto: BigInt(env.FAUCET_YOCTO ?? '5000000000000000000000000'),
    accountHour: Number(env.RELAY_ACCOUNT_HOUR ?? 120),
    accountDay: Number(env.RELAY_ACCOUNT_DAY ?? 2000),
    ipHour: Number(env.RELAY_IP_HOUR ?? 600),
    placeBetMs: Number(env.RELAY_PLACE_BET_MS ?? 600),
    dailyGasTgas: Number(env.RELAY_DAILY_GAS_TGAS ?? 250_000),
    // a venue shares one Wi-Fi address, so the per-IP cap is generous; accountsTotal is the real budget
    accountsPerIpDay: Number(env.ACCOUNTS_PER_IP_DAY ?? 40),
    accountsTotal: Number(env.ACCOUNTS_TOTAL ?? 3000),
    faucetPerIpDay: Number(env.FAUCET_PER_IP_DAY ?? 40),
    agentKeys: list(env.AGENT_KEYS),
    priestAccount: env.PRIEST_ACCOUNT ?? '',
    priestKeys: list(env.PRIEST_KEYS),
    nearaiKey: env.NEARAI_API_KEY ?? '',
    oracleSecret: env.ORACLE_SECRET ?? '',
    nearaiBase: (env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, ''),
    nearaiModel: env.NEARAI_MODEL || 'Qwen/Qwen3.8-27B',
    nearaiDailyTokens: Number(env.NEARAI_DAILY_TOKEN_CAP ?? 150_000),
    chatTokenShare: Number(env.NEARAI_CHAT_SHARE ?? 0.6),
    agentsDisabled: env.AGENTS_DISABLED === '1',
    agentEveryMin: Number(env.AGENT_EVERY_MIN ?? 10),
    askPerAccountHour: Number(env.ASK_PER_ACCOUNT_HOUR ?? 10),
    askPerIpHour: Number(env.ASK_PER_IP_HOUR ?? 60),
    rpcPerIpHour: Number(env.RPC_PER_IP_HOUR ?? 60_000),
  };
}
