CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS quota (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count BIGINT NOT NULL,
  gas_tgas BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, id, bucket)
);
CREATE TABLE IF NOT EXISTS dealer_seeds (
  idx BIGINT PRIMARY KEY,
  commit TEXT NOT NULL,
  seed_enc TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS deny_list (
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);
CREATE TABLE IF NOT EXISTS bets (
  bet_id BIGINT PRIMARY KEY,
  account_id TEXT NOT NULL,
  game TEXT NOT NULL,
  wager TEXT NOT NULL,
  payout TEXT,
  outcome JSONB,
  server_seed TEXT,
  client_seed TEXT,
  chain_seed TEXT,
  via TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bets_account ON bets (account_id, bet_id DESC);
CREATE TABLE IF NOT EXISTS agent_decisions (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL,
  detail JSONB NOT NULL,
  line TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS faucet_grants (
  account_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS players (
  account_id TEXT PRIMARY KEY,
  wagered TEXT NOT NULL DEFAULT '0',
  net TEXT NOT NULL DEFAULT '0',
  faith_milli INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS faucet_account ON faucet_grants (account_id, at DESC);
CREATE INDEX IF NOT EXISTS faucet_ip ON faucet_grants (ip, at DESC);
ALTER TABLE players ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE bets ADD COLUMN IF NOT EXISTS detail TEXT NOT NULL DEFAULT '';
ALTER TABLE bets ADD COLUMN IF NOT EXISTS settle_ms INTEGER;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS tx_hash TEXT;

-- Round 3: the AI hosts (BACKEND_PLAN R3-5)
CREATE TABLE IF NOT EXISTS agent_attestations (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model TEXT NOT NULL,
  nonce TEXT NOT NULL,
  signing_address TEXT NOT NULL,
  intel_quote_bytes INTEGER NOT NULL DEFAULT 0,
  has_gpu_evidence BOOLEAN NOT NULL DEFAULT false,
  report_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_attestations_model ON agent_attestations (model, id DESC);
CREATE TABLE IF NOT EXISTS host_decisions (
  id UUID PRIMARY KEY,
  agent TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  policy TEXT NOT NULL,
  observation_json JSONB NOT NULL,
  action TEXT NOT NULL,
  params_json JSONB NOT NULL,
  line TEXT NOT NULL,
  applied BOOLEAN NOT NULL,
  reason TEXT,
  tx_hash TEXT,
  model TEXT,
  chat_id TEXT,
  request_b64 TEXT,
  response_b64 TEXT,
  signed_text TEXT,
  signature TEXT,
  signing_address TEXT,
  signature_kind TEXT,
  attestation_id BIGINT REFERENCES agent_attestations (id),
  tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS host_decisions_agent ON host_decisions (agent, at DESC);
CREATE INDEX IF NOT EXISTS host_decisions_at ON host_decisions (at DESC);

-- usernames: one display name per account, unique ignoring case / spaces / _ - ' (so "Magpie77" and "magpie 77" collide)
CREATE TABLE IF NOT EXISTS usernames (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS blessing TEXT;
