import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { AccountRow, AttestationRow, BetRow, HostDecisionRow, PlayerRow, SeedRow, Store } from './store.ts';

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../sql/001_init.sql'), 'utf8');

export class PostgresStore implements Store {
  constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresStore> {
    const pool = new pg.Pool({
      connectionString: url.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]$/, ''),
      max: 8,
      ssl: /sslmode=(require|verify-full|verify-ca|no-verify)/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    // An idle pooled connection can drop (network blip, the database restarting). pg reports that as an 'error'
    // event on the pool; without a listener Node treats it as fatal and the whole server exits. Log it: the pool
    // discards the broken client and opens a new one on the next query.
    pool.on('error', (err) => console.error(JSON.stringify({ at: 'db', error: err.message })));
    const store = new PostgresStore(pool);
    await pool.query(SCHEMA);
    return store;
  }

  async account(id: string) {
    const r = await this.pool.query('select account_id, public_key, ip, created_at from accounts where account_id = $1', [id]);
    const row = r.rows[0];
    return row ? { accountId: row.account_id, publicKey: row.public_key, ip: row.ip, createdAt: new Date(row.created_at).getTime() } : null;
  }
  async nameOwner(key: string) {
    const r = await this.pool.query('select account_id, name from usernames where name_key = $1', [key]);
    return r.rows[0] ? { accountId: String(r.rows[0].account_id), name: String(r.rows[0].name) } : null;
  }
  async nameOf(accountId: string) {
    const r = await this.pool.query('select name from usernames where account_id = $1', [accountId]);
    return r.rows[0] ? String(r.rows[0].name) : null;
  }
  async claimName(accountId: string, key: string, name: string) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const held = await c.query('select account_id from usernames where name_key = $1 for update', [key]);
      if (held.rows[0] && held.rows[0].account_id !== accountId) { await c.query('rollback'); return false; }
      await c.query('delete from usernames where account_id = $1', [accountId]);
      const ins = await c.query('insert into usernames (name_key, name, account_id) values ($1,$2,$3) on conflict do nothing', [key, name, accountId]);
      if ((ins.rowCount ?? 0) === 0) { await c.query('rollback'); return false; }
      await c.query('commit');
      return true;
    } catch (err) { await c.query('rollback').catch(() => {}); throw err; }
    finally { c.release(); }
  }
  async insertAccount(row: AccountRow) {
    const r = await this.pool.query(
      'insert into accounts (account_id, public_key, ip, created_at) values ($1,$2,$3,to_timestamp($4 / 1000.0)) on conflict do nothing',
      [row.accountId, row.publicKey, row.ip, row.createdAt],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async countAccounts() {
    const r = await this.pool.query('select count(*)::int as n from accounts');
    return r.rows[0].n as number;
  }
  async accountsByIpSince(ip: string, sinceMs: number) {
    const r = await this.pool.query('select count(*)::int as n from accounts where ip = $1 and created_at >= to_timestamp($2 / 1000.0)', [ip, sinceMs]);
    return r.rows[0].n as number;
  }
  async quota(scope: string, id: string, bucket: string) {
    const r = await this.pool.query('select count, gas_tgas from quota where scope = $1 and id = $2 and bucket = $3', [scope, id, bucket]);
    const row = r.rows[0];
    return row ? { count: Number(row.count), gasTgas: Number(row.gas_tgas) } : { count: 0, gasTgas: 0 };
  }
  async addQuota(scope: string, id: string, bucket: string, count: number, gasTgas: number) {
    await this.pool.query(
      `insert into quota (scope, id, bucket, count, gas_tgas) values ($1,$2,$3,$4,$5)
       on conflict (scope, id, bucket) do update set count = quota.count + $4, gas_tgas = quota.gas_tgas + $5`,
      [scope, id, bucket, count, gasTgas],
    );
  }
  async setQuota(scope: string, id: string, bucket: string, count: number, gasTgas: number) {
    await this.pool.query(
      `insert into quota (scope, id, bucket, count, gas_tgas) values ($1,$2,$3,$4,$5)
       on conflict (scope, id, bucket) do update set count = $4, gas_tgas = $5`,
      [scope, id, bucket, count, gasTgas],
    );
  }
  async denied(kind: string, value: string) {
    const r = await this.pool.query('select 1 from deny_list where kind = $1 and value = $2', [kind, value]);
    return (r.rowCount ?? 0) > 0;
  }
  async putSeed(row: SeedRow) {
    await this.pool.query(
      `insert into dealer_seeds (idx, commit, seed_enc, status) values ($1,$2,$3,$4)
       on conflict (idx) do update set commit = $2, seed_enc = $3, status = $4`,
      [row.idx, row.commit, row.seedEnc, row.status],
    );
  }
  async seed(idx: number) {
    const r = await this.pool.query('select idx, commit, seed_enc, status from dealer_seeds where idx = $1', [idx]);
    const row = r.rows[0];
    return row ? { idx: Number(row.idx), commit: row.commit, seedEnc: row.seed_enc, status: row.status } : null;
  }
  async seedsByStatus(status: string) {
    const r = await this.pool.query('select idx, commit, seed_enc, status from dealer_seeds where status = $1 order by idx', [status]);
    return r.rows.map((row) => ({ idx: Number(row.idx), commit: row.commit, seedEnc: row.seed_enc, status: row.status }));
  }
  async markSeed(idx: number, status: string) {
    await this.pool.query('update dealer_seeds set status = $2 where idx = $1', [idx, status]);
  }
  async recordBet(row: BetRow) {
    await this.pool.query(
      `insert into bets (bet_id, account_id, game, wager, payout, outcome, server_seed, client_seed, chain_seed, via, detail, settle_ms, tx_hash, blessing)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (bet_id) do nothing`,
      [row.betId, row.accountId, row.game, row.wager, row.payout, JSON.stringify(row.outcome), row.serverSeed, row.clientSeed, row.chainSeed, row.via, row.detail ?? '', row.settleMs ?? null, row.txHash ?? null, row.blessing ?? null],
    );
  }
  async blessingsSince(sinceMs: number) {
    const r = await this.pool.query(`select coalesce(sum(blessing::numeric), 0)::text as s from bets where created_at >= to_timestamp($1 / 1000.0) and blessing is not null`, [sinceMs]);
    return BigInt(String(r.rows[0]?.s ?? '0').split('.')[0]);
  }
  async bet(id: number) {
    const r = await this.pool.query('select * from bets where bet_id = $1', [id]);
    return r.rows[0] ? mapBet(r.rows[0]) : null;
  }
  async recentBets(accountId: string, limit: number) {
    const r = await this.pool.query('select * from bets where account_id = $1 order by bet_id desc limit $2', [accountId, limit]);
    return r.rows.map(mapBet);
  }
  async player(accountId: string) {
    const r = await this.pool.query('select account_id, wagered, net, faith_milli, name from players where account_id = $1', [accountId]);
    return r.rows[0] ? mapPlayer(r.rows[0]) : null;
  }
  async upsertPlayer(row: PlayerRow) {
    await this.pool.query(
      `insert into players (account_id, wagered, net, faith_milli, name) values ($1,$2,$3,$4,$5)
       on conflict (account_id) do update set wagered = $2, net = $3, faith_milli = $4,
         name = case when $5 <> '' then $5 else players.name end, updated_at = now()`,
      [row.accountId, row.wagered, row.net, row.faithMilli, row.name ?? ''],
    );
  }
  async leaderboard(by: 'wagered' | 'faith' | 'net', limit: number) {
    const col = by === 'faith' ? 'faith_milli' : by === 'net' ? 'net::numeric' : 'wagered::numeric';
    const r = await this.pool.query(`select account_id, wagered, net, faith_milli, name from players order by ${col} desc limit $1`, [limit]);
    return r.rows.map(mapPlayer);
  }
  async countPlayers() {
    const r = await this.pool.query('select count(*)::int as n from players');
    return r.rows[0].n as number;
  }
  async volumeYocto() {
    const r = await this.pool.query(`select coalesce(sum(wager::numeric), 0)::text as n from bets`);
    return r.rows[0].n as string;
  }
  async timeoutCount() {
    const r = await this.pool.query(`select count(*)::int as n from bets where via = 'timeout'`);
    return r.rows[0].n as number;
  }
  async faucetSince(accountId: string, sinceMs: number) {
    const r = await this.pool.query('select count(*)::int as n from faucet_grants where account_id = $1 and at >= to_timestamp($2 / 1000.0)', [accountId, sinceMs]);
    return r.rows[0].n as number;
  }
  async faucetIpSince(ip: string, sinceMs: number) {
    const r = await this.pool.query('select count(*)::int as n from faucet_grants where ip = $1 and at >= to_timestamp($2 / 1000.0)', [ip, sinceMs]);
    return r.rows[0].n as number;
  }
  async recordFaucet(accountId: string, ip: string, at: number) {
    await this.pool.query('insert into faucet_grants (account_id, ip, at) values ($1,$2,to_timestamp($3 / 1000.0))', [accountId, ip, at]);
  }
  async addHostDecision(d: HostDecisionRow) {
    await this.pool.query(
      `insert into host_decisions (id, agent, at, policy, observation_json, action, params_json, line, applied, reason, tx_hash, model, chat_id,
         request_b64, response_b64, signed_text, signature, signing_address, signature_kind, attestation_id, tokens)
       values ($1,$2,to_timestamp($3 / 1000.0),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       on conflict (id) do update set applied = $9, reason = $10, tx_hash = $11`,
      [d.id, d.agent, d.at, d.policy, JSON.stringify(d.observation), d.action, JSON.stringify(d.params), d.line, d.applied, d.reason, d.txHash,
        d.model, d.chatId, d.requestB64, d.responseB64, d.signedText, d.signature, d.signingAddress, d.signatureKind, d.attestationId, d.tokens],
    );
  }
  async hostDecisions(agent: 'fortuna' | 'nakamoto' | 'all', limit: number) {
    const r = agent === 'all'
      ? await this.pool.query('select * from host_decisions order by at desc limit $1', [limit])
      : await this.pool.query('select * from host_decisions where agent = $1 order by at desc limit $2', [agent, limit]);
    return r.rows.map(mapHostDecision);
  }
  async hostDecision(id: string) {
    const r = await this.pool.query('select * from host_decisions where id = $1', [id]);
    return r.rows[0] ? mapHostDecision(r.rows[0]) : null;
  }
  async addAttestation(a: Omit<AttestationRow, 'id'>) {
    const r = await this.pool.query(
      `insert into agent_attestations (at, model, nonce, signing_address, intel_quote_bytes, has_gpu_evidence, report_json)
       values (to_timestamp($1 / 1000.0),$2,$3,$4,$5,$6,$7) returning id`,
      [a.at, a.model, a.nonce, a.signingAddress, a.intelQuoteBytes, a.hasGpuEvidence, JSON.stringify(a.report)],
    );
    return { ...a, id: Number(r.rows[0].id) };
  }
  async attestation(id: number) {
    const r = await this.pool.query('select * from agent_attestations where id = $1', [id]);
    return r.rows[0] ? mapAttestation(r.rows[0]) : null;
  }
  async latestAttestation(model: string) {
    const r = await this.pool.query('select * from agent_attestations where model = $1 order by id desc limit 1', [model]);
    return r.rows[0] ? mapAttestation(r.rows[0]) : null;
  }
  async biggestWin(sinceMs: number) {
    const r = await this.pool.query(
      `select account_id, game, payout from bets
       where created_at >= to_timestamp($1 / 1000.0) and payout is not null and payout::numeric > wager::numeric
       order by payout::numeric desc limit 1`,
      [sinceMs],
    );
    const row = r.rows[0];
    return row ? { accountId: String(row.account_id), game: String(row.game), payout: String(row.payout) } : null;
  }
  async tryDealerLock() {
    const r = await this.pool.query('select pg_try_advisory_lock(8675309) as ok');
    return Boolean(r.rows[0].ok);
  }
  async dayStats(sinceMs: number) {
    const r = await this.pool.query(
      `select count(*)::int as bets,
              coalesce(sum(wager::numeric), 0)::text as volume,
              coalesce(sum(wager::numeric) - sum(coalesce(payout, '0')::numeric), 0)::text as house,
              count(*) filter (where via = 'timeout')::int as timeouts,
              coalesce(avg(settle_ms), 0)::int as avg_ms
       from bets where created_at >= to_timestamp($1 / 1000.0)`,
      [sinceMs],
    );
    const row = r.rows[0];
    return { bets: row.bets as number, volume: String(row.volume), houseNet: String(row.house), timeouts: row.timeouts as number, avgSettleMs: row.avg_ms as number };
  }
}

function mapBet(row: Record<string, unknown>): BetRow {
  return {
    betId: Number(row.bet_id), accountId: String(row.account_id), game: String(row.game), wager: String(row.wager),
    payout: row.payout == null ? null : String(row.payout),
    outcome: typeof row.outcome === 'string' ? JSON.parse(row.outcome) : row.outcome,
    serverSeed: String(row.server_seed ?? ''), clientSeed: String(row.client_seed ?? ''), chainSeed: String(row.chain_seed ?? ''),
    via: String(row.via ?? ''), createdAt: row.created_at ? new Date(String(row.created_at)).getTime() : Date.now(),
    detail: row.detail == null ? '' : String(row.detail),
    settleMs: row.settle_ms == null ? null : Number(row.settle_ms),
    txHash: row.tx_hash == null ? null : String(row.tx_hash),
  };
}
function mapPlayer(row: Record<string, unknown>): PlayerRow {
  return { accountId: String(row.account_id), wagered: String(row.wagered), net: String(row.net), faithMilli: Number(row.faith_milli), name: String(row.name ?? '') };
}
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const str = (v: unknown) => (v == null ? null : String(v));
function mapHostDecision(row: Record<string, unknown>): HostDecisionRow {
  return {
    id: String(row.id), agent: row.agent === 'nakamoto' ? 'nakamoto' : 'fortuna', at: new Date(String(row.at)).getTime(),
    policy: row.policy === 'llm' ? 'llm' : 'rules', observation: json(row.observation_json), action: String(row.action),
    params: (json(row.params_json) ?? {}) as Record<string, number | string>, line: String(row.line), applied: Boolean(row.applied),
    reason: str(row.reason), txHash: str(row.tx_hash), model: str(row.model), chatId: str(row.chat_id),
    requestB64: str(row.request_b64), responseB64: str(row.response_b64), signedText: str(row.signed_text), signature: str(row.signature),
    signingAddress: str(row.signing_address), signatureKind: str(row.signature_kind),
    attestationId: row.attestation_id == null ? null : Number(row.attestation_id), tokens: Number(row.tokens ?? 0),
  };
}
function mapAttestation(row: Record<string, unknown>): AttestationRow {
  return {
    id: Number(row.id), at: new Date(String(row.at)).getTime(), model: String(row.model), nonce: String(row.nonce),
    signingAddress: String(row.signing_address), intelQuoteBytes: Number(row.intel_quote_bytes), hasGpuEvidence: Boolean(row.has_gpu_evidence),
    report: json(row.report_json),
  };
}
