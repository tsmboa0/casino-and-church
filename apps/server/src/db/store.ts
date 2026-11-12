export interface AccountRow {
  accountId: string;
  publicKey: string;
  ip: string;
  createdAt: number;
}

export interface SeedRow {
  idx: number;
  commit: string;
  seedEnc: string;
  status: string;
}

export interface BetRow {
  betId: number;
  accountId: string;
  game: string;
  wager: string;
  payout: string | null;
  outcome: unknown;
  serverSeed: string;
  clientSeed: string;
  chainSeed: string;
  via: string;
  createdAt: number;
  detail?: string;
  settleMs?: number | null;
  /** the dealer's settling transaction (reveal / last blackjack_show): where the result is on chain */
  txHash?: string | null;
  /** the treasury-paid bonus on this win (yocto) */
  blessing?: string | null;
}

export interface AuthRow {
  nameKey: string;
  username: string;
  accountId: string;
  salt: string;
  iterations: number;
  authHash: string;
  walletIv: string;
  walletCt: string;
}

export interface PlayerRow {
  accountId: string;
  wagered: string;
  net: string;
  faithMilli: number;
  name?: string;
}

/** One host decision (R3-5). `policy` says who chose it: the model (signed) or the rule fallback (unsigned). */
export interface HostDecisionRow {
  id: string;
  agent: 'fortuna' | 'nakamoto';
  at: number;
  policy: 'llm' | 'rules';
  observation: unknown;
  action: string;
  /** what the feed shows; `player` (alms) is kept here but never sent to clients */
  params: Record<string, number | string>;
  line: string;
  applied: boolean;
  reason: string | null;
  txHash: string | null;
  model: string | null;
  chatId: string | null;
  requestB64: string | null;
  responseB64: string | null;
  signedText: string | null;
  signature: string | null;
  signingAddress: string | null;
  signatureKind: string | null;
  attestationId: number | null;
  tokens: number;
}

export interface AttestationRow {
  id: number;
  at: number;
  model: string;
  nonce: string;
  signingAddress: string;
  intelQuoteBytes: number;
  hasGpuEvidence: boolean;
  report: unknown;
}

export interface Store {
  account(id: string): Promise<AccountRow | null>;
  /** secured accounts (username + password) */
  authByName(nameKey: string): Promise<AuthRow | null>;
  authByAccount(accountId: string): Promise<AuthRow | null>;
  /** false if the name or the account is already secured */
  insertAuth(row: AuthRow): Promise<boolean>;
  /** the username registry (server-side, not on chain) */
  nameOwner(nameKey: string): Promise<{ accountId: string; name: string } | null>;
  nameOf(accountId: string): Promise<string | null>;
  /** atomically give `name` to the account (releasing its previous name); false if another account holds it */
  claimName(accountId: string, nameKey: string, name: string): Promise<boolean>;
  insertAccount(row: AccountRow): Promise<boolean>;
  countAccounts(): Promise<number>;
  accountsByIpSince(ip: string, sinceMs: number): Promise<number>;
  quota(scope: string, id: string, bucket: string): Promise<{ count: number; gasTgas: number }>;
  addQuota(scope: string, id: string, bucket: string, count: number, gasTgas: number): Promise<void>;
  setQuota(scope: string, id: string, bucket: string, count: number, gasTgas: number): Promise<void>;
  denied(kind: string, value: string): Promise<boolean>;
  putSeed(row: SeedRow): Promise<void>;
  seed(idx: number): Promise<SeedRow | null>;
  seedsByStatus(status: string): Promise<SeedRow[]>;
  markSeed(idx: number, status: string): Promise<void>;
  recordBet(row: BetRow): Promise<void>;
  /** total blessing paid by the treasury since `sinceMs` (yocto) */
  blessingsSince(sinceMs: number): Promise<bigint>;
  bet(id: number): Promise<BetRow | null>;
  recentBets(accountId: string, limit: number): Promise<BetRow[]>;
  upsertPlayer(row: PlayerRow): Promise<void>;
  player(accountId: string): Promise<PlayerRow | null>;
  leaderboard(by: 'wagered' | 'faith' | 'net', limit: number): Promise<PlayerRow[]>;
  countPlayers(): Promise<number>;
  volumeYocto(): Promise<string>;
  timeoutCount(): Promise<number>;
  faucetSince(accountId: string, sinceMs: number): Promise<number>;
  faucetIpSince(ip: string, sinceMs: number): Promise<number>;
  recordFaucet(accountId: string, ip: string, at: number): Promise<void>;
  addHostDecision(row: HostDecisionRow): Promise<void>;
  hostDecisions(agent: 'fortuna' | 'nakamoto' | 'all', limit: number): Promise<HostDecisionRow[]>;
  hostDecision(id: string): Promise<HostDecisionRow | null>;
  addAttestation(row: Omit<AttestationRow, 'id'>): Promise<AttestationRow>;
  attestation(id: number): Promise<AttestationRow | null>;
  latestAttestation(model: string): Promise<AttestationRow | null>;
  biggestWin(sinceMs: number): Promise<{ accountId: string; game: string; payout: string } | null>;
  dayStats(sinceMs: number): Promise<{ bets: number; volume: string; houseNet: string; timeouts: number; avgSettleMs: number }>;
  /** One dealer process. Postgres uses an advisory lock; memory always grants it. */
  tryDealerLock(): Promise<boolean>;
}
