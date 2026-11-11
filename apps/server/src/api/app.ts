import { base58Decode, bytesToHex, campaignApprovalMessage, campaignClaimMessage, campaignProblem, cleanName, hexToBytes, keypairFromSecret, nameClaimMessage, nameKey, nameProblem, parseSecret, publicKeyString, type NewCampaign } from '@cnc/shared';
import { ed25519 } from '@noble/curves/ed25519';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { HttpError } from '../http.ts';
import type { Hub } from '../indexer/hub.ts';
import type { Dealer } from '../dealer/dealer.ts';
import { acceptRelay } from '../relayer/relay.ts';
import type { SignedDelegate } from '@cnc/shared';
import type { Hosts } from '../agent/service.ts';
import type { Activity } from '../agent/activity.ts';

export interface AppDeps {
  config: Config;
  store: Store;
  hub: Hub;
  height: () => Promise<bigint>;
  broadcast: (signed: SignedDelegate) => Promise<string>;
  transfer?: (to: string, yocto: bigint) => Promise<string>;
  view?: (method: string, args: unknown) => Promise<unknown>;
  balance?: (account: string) => Promise<bigint>;
  lag?: () => Promise<number>;
  dealer?: Dealer;
  agents?: Hosts;
  activity?: Activity;
  rpcEndpoint?: () => string;
  /** raw JSON-RPC to the configured NEAR endpoint(s), for the /rpc proxy */
  rpcCall?: (method: string, params: unknown) => Promise<unknown>;
}

const DAY = 86_400_000;
/** the relayer keeps at least this much for gas and new accounts; the faucet stops above it */
const RELAYER_RESERVE = 2n * 10n ** 24n;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });
  // CLIENT_ORIGIN: '*', one origin, or a comma-separated list (localhost and 127.0.0.1 are different origins)
  const origins = deps.config.clientOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  const origin = origins.includes('*') ? true : origins.length > 1 ? origins : origins[0] ?? false;
  const sseOrigin = (reqOrigin: string | undefined) => (origins.includes('*') ? '*' : reqOrigin && origins.includes(reqOrigin) ? reqOrigin : origins[0] ?? '');
  void app.register(cors, { origin });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
      reply.code(err.status).send({ error: err.code, message: err.message });
      return;
    }
    reply.code(500).send({ error: 'bad_args', message: 'The server failed.' });
  });

  // The client's boot waits on /healthz, so it must answer fast: the RPC reads run in parallel and the body is
  // cached for a few seconds (a slow or rate-limited RPC used to push this past the client's timeout).
  let healthCache: { at: number; body: unknown } | null = null;
  let healthInflight: Promise<unknown> | null = null;
  app.get('/healthz', async () => {
    if (healthCache && Date.now() - healthCache.at < 5_000) return healthCache.body;
    if (!healthInflight) {
      healthInflight = health().then((body) => { healthCache = { at: Date.now(), body }; return body; }).finally(() => { healthInflight = null; });
    }
    return healthInflight;
  });

  let lastPools: { at: number; body: any } | null = null;
  async function health() {
    const dealer = deps.dealer?.status;
    const safe = async <T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
      if (!fn) return fallback;
      try { return await fn(); } catch { return fallback; }
    };
    const readPools = deps.view && deps.config.contract ? () => deps.view!('get_pools', {}) as Promise<any> : undefined;
    const [pools0, lag, relayerBalance, dealerBalance] = await Promise.all([
      // one retry: a single dropped RPC read must not mark the whole server unhealthy
      safe(readPools ? () => readPools().catch(() => readPools()) : undefined, null as any),
      safe(deps.lag, 0),
      safe(deps.balance && deps.config.relayerAccount ? async () => (await deps.balance!(deps.config.relayerAccount)).toString() : undefined, '0'),
      safe(deps.balance && deps.config.dealerAccount ? async () => (await deps.balance!(deps.config.dealerAccount)).toString() : undefined, '0'),
    ]);
    if (pools0 !== null) lastPools = { at: Date.now(), body: pools0 };
    const pools = pools0 ?? (lastPools && Date.now() - lastPools.at < 60_000 ? lastPools.body : null);
    const ok = pools !== null;
    const hour = new Date();
    const stamp = `h:${hour.getUTCFullYear()}${String(hour.getUTCMonth() + 1).padStart(2, '0')}${String(hour.getUTCDate()).padStart(2, '0')}${String(hour.getUTCHours()).padStart(2, '0')}`;
    const errors = await deps.store.quota('errors', 'relay', stamp);
    const day = await deps.store.dayStats(Date.now() - DAY);
    return {
      ok,
      contract: deps.config.contract,
      relayer_account: deps.config.relayerAccount,
      network: deps.config.network,
      block_height_lag: lag,
      relayer_balance: relayerBalance,
      dealer_balance: dealerBalance,
      commits_available: Number(pools?.commits_available ?? dealer?.commitsAvailable ?? 0),
      pending_bets: Number(pools?.pending_bets ?? dealer?.pendingBets ?? 0),
      oldest_pending_age_s: dealer?.oldestPendingAgeS ?? 0,
      dealer_running: Boolean(dealer?.running),
      dealer_inflight: dealer?.inflight ?? 0,
      timeouts_24h: day.timeouts,
      relay_errors_1h: errors.count,
      relayer_low: BigInt(relayerBalance) < RELAYER_RESERVE,
      rpc: deps.rpcEndpoint?.() ?? null,
      agents: deps.agents?.status() ?? null,
    };
  }

  let statsCache: { at: number; body: unknown } | null = null;
  app.get('/stats', async () => {
    if (statsCache && Date.now() - statsCache.at < 10_000) return statsCache.body;
    let pools: any = null;
    let chip = 10n ** 22n;
    if (deps.view && deps.config.contract) {
      try { pools = await deps.view('get_pools', {}); } catch { pools = null; }
      try {
        const params = await deps.view('get_params', {}) as { chip_yocto?: string };
        if (params?.chip_yocto) chip = BigInt(params.chip_yocto);
      } catch { /* keep the default chip */ }
    }
    const day = await deps.store.dayStats(Date.now() - DAY);
    const chips = (yocto: string) => Number(BigInt(yocto.split('.')[0] || '0') / chip);
    const body = {
      players: await deps.store.countPlayers(),
      bets_24h: day.bets,
      volume_chips: chips(day.volume),
      volume: day.volume,
      vault: pools?.vault ?? '0',
      treasury: pools?.treasury ?? '0',
      jackpot: pools?.jackpot ?? '0',
      house_net_24h_chips: chips(day.houseNet),
      timeouts_24h: day.timeouts,
      avg_settle_ms: day.avgSettleMs,
      timeouts: await deps.store.timeoutCount(),
    };
    statsCache = { at: Date.now(), body };
    return body;
  });

  app.get('/leaderboard', async (req) => {
    const by = (req.query as { by?: string }).by;
    const key = by === 'faith' || by === 'net' ? by : 'wagered';
    let chip = 10n ** 22n;
    if (deps.view && deps.config.contract) {
      try {
        const params = await deps.view('get_params', {}) as { chip_yocto?: string };
        if (params?.chip_yocto) chip = BigInt(params.chip_yocto);
      } catch { /* default chip */ }
    }
    const rows = await deps.store.leaderboard(key, 20);
    return {
      by: key,
      demo: false,
      rows: rows.map((row, index) => ({
        rank: index + 1,
        name: row.name || row.accountId.slice(0, 8),
        account_id: row.accountId,
        wagered: Number(BigInt(row.wagered) / chip),
        net: Number(BigInt(row.net) / chip),
      })),
    };
  });

  app.get('/player/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const player = deps.view && deps.config.contract ? await deps.view('get_player', { account_id: id }) : await deps.store.player(id);
    const bets = await deps.store.recentBets(id, 20);
    return { player, bets };
  });

  app.get('/bets', async (req) => {
    const query = req.query as { account?: string; limit?: string };
    if (!query.account) throw new HttpError(400, 'bad_args', 'account is required.');
    const limit = Math.min(40, Math.max(1, Number(query.limit ?? 40) || 40));
    return { bets: await deps.store.recentBets(query.account, limit) };
  });

  app.get('/bets/:id', async (req) => {
    const row = await deps.store.bet(Number((req.params as { id: string }).id));
    if (!row) throw new HttpError(404, 'unknown_bet', 'No such bet.');
    return row;
  });

  // ---- the AI hosts (BACKEND_PLAN R3-5, R3-9) ----
  const host = (v: unknown) => (v === 'nakamoto' ? 'nakamoto' : v === 'fortuna' ? 'fortuna' : null);
  const cached = new Map<string, { at: number; body: unknown }>();
  const memo = async (key: string, ms: number, fn: () => Promise<unknown>) => {
    const hit = cached.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.body;
    const body = await fn();
    cached.set(key, { at: Date.now(), body });
    return body;
  };
  const viewOr = async <T>(method: string, fallback: T): Promise<T> => {
    if (!deps.view || !deps.config.contract) return fallback;
    try { return (await deps.view(method, {})) as T; } catch { return fallback; }
  };

  app.get('/agent/feed', async (req) => {
    const q = req.query as { agent?: string; limit?: string };
    const agent = host(q.agent) ?? 'all';
    const limit = Math.min(40, Math.max(1, Number(q.limit ?? 20) || 20));
    if (!deps.agents) return { decisions: [] };
    return memo(`feed:${agent}:${limit}`, 5_000, async () => ({ decisions: await deps.agents!.feed(agent, limit) }));
  });

  app.get('/agent/decision/:id/proof', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'bad_args', 'Bad decision id.');
    const proof = deps.agents ? await deps.agents.proof(id) : null;
    if (!proof) throw new HttpError(404, 'unknown_decision', 'No such decision.');
    return proof;
  });

  app.get('/agent/attestation/latest', async () => {
    const att = deps.agents ? await deps.agents.attestation() : null;
    if (!att) throw new HttpError(404, 'no_attestation', 'No attestation on file yet.');
    return { id: att.id, at: att.at, model: att.model, nonce: att.nonce, signing_address: att.signingAddress, report: att.report };
  });

  app.get('/agent/line', async (req) => {
    const agent = host((req.query as { agent?: string }).agent) ?? 'fortuna';
    const rows = deps.agents ? await deps.agents.feed(agent, 10) : [];
    const row = rows.find((r) => r.applied) ?? rows[0];
    return { line: row?.line ?? (agent === 'fortuna' ? 'The house is open.' : 'The doors are open, child.'), decision_id: row?.id ?? null };
  });

  app.get('/events/active', async () => memo('events', 5_000, async () => {
    const rows = await viewOr<any[]>('get_events', []);
    return {
      events: rows.map((e) => ({
        kind: e.kind, realm: e.realm, endsAt: Number(BigInt(e.ends_ns) / 1_000_000n), startedAt: Number(BigInt(e.started_ns) / 1_000_000n),
        boostBps: Number(e.boost_bps), by: e.realm === 'church' ? 'nakamoto' : 'fortuna',
      })),
    };
  }));

  app.get('/stats/house', async () => memo('house', 10_000, async () => {
    const [pools, params] = await Promise.all([viewOr<any>('get_pools', null), viewOr<any>('get_params', null)]);
    const chip = BigInt(params?.chip_yocto ?? 10n ** 22n);
    const c = (v: unknown) => Number(BigInt(String(v ?? '0').split('.')[0] || '0') / chip);
    const day = await deps.store.dayStats(Date.now() - DAY);
    const best = await deps.store.biggestWin(Date.now() - DAY);
    const bestName = best ? (await deps.store.player(best.accountId))?.name || 'A guest' : '';
    const p = deps.activity?.presence() ?? { online: 0, casino: 0, church: 0, plaza: 0 };
    const volume = c(day.volume), net = c(day.houseNet);
    return {
      playersOnline: p.online, inCasino: p.casino, inChurch: p.church, inPlaza: p.plaza,
      volume24h: volume, houseNet24h: net, vault: c(pools?.vault), vaultFree: c(pools?.vault_free), jackpot: c(pools?.jackpot),
      maxBet: Number(params?.effective_max_bet_chips ?? params?.max_bet_chips ?? 0), luckPerChipMilli: Number(params?.luck_per_chip_milli ?? 0),
      edgeRealized24h: volume ? net / volume : 0, edgeExpected: 0.045,
      biggestWin24h: best ? { name: bestName, chips: c(best.payout), game: best.game.toLowerCase() } : null,
      timeouts24h: day.timeouts,
    };
  }));

  app.get('/stats/church', async () => memo('church', 10_000, async () => {
    const [pools, params] = await Promise.all([viewOr<any>('get_pools', null), viewOr<any>('get_params', null)]);
    const chip = BigInt(params?.chip_yocto ?? 10n ** 22n);
    const c = (v: unknown) => Number(BigInt(String(v ?? '0').split('.')[0] || '0') / chip);
    const since = Date.now() - DAY;
    const alms = deps.agents ? (await deps.store.hostDecisions('nakamoto', 200)).filter((d) => d.applied && d.action === 'grant_alms' && d.at >= since) : [];
    return {
      treasury: c(pools?.treasury), tithes24h: deps.activity?.sum('tithe', since) ?? 0, candles24h: deps.activity?.count('light_candle', since) ?? 0,
      alms24h: alms.reduce((n, d) => n + Number(d.params.chips ?? 0), 0), blessingsPaid24h: c(String(await deps.store.blessingsSince(since))),
      blessingCapBps: Number(params?.blessing_day_cap_bps ?? 0), candleFaithMilli: Number(params?.candle_faith_milli ?? 0),
      faithfulOnline: deps.activity?.presence().church ?? 0,
    };
  }));

  app.post('/agent/ask', async (req) => {
    const body = (req.body ?? {}) as { agent?: string; question?: string; account_id?: string };
    const agent = host(body.agent);
    if (!agent) throw new HttpError(400, 'bad_args', 'Ask Don Fortuna or Father Nakamoto.');
    if (typeof body.question !== 'string') throw new HttpError(400, 'bad_args', 'Ask a question.');
    // the caller must be one of our accounts (guest keys made here); anonymous askers share the per-IP limit
    const account = typeof body.account_id === 'string' && (await deps.store.account(body.account_id)) ? body.account_id : '';
    if (!deps.agents) throw new HttpError(503, 'dealer_offline', 'The hosts are resting.');
    const r = await deps.agents.ask(agent, body.question, account, req.ip);
    return { answer: r.answer, relevant: r.relevant, ...(r.proof ? { proof: r.proof } : {}) };
  });

  app.get('/events/:account', (req, reply) => {
    const account = (req.params as { account: string }).account;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': sseOrigin(req.headers.origin),
      vary: 'origin',
    });
    const listener = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    deps.hub.add(account, listener);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(ping); deps.hub.remove(account, listener); });
  });

  // ---- NEAR RPC proxy for the browser ----
  // The client reads the chain through us, so a paid RPC key stays on the server and a venue full of players on
  // one Wi-Fi address does not hit a free provider's per-IP limit. Read methods only, plus send_tx without
  // waiting (the player's own signed deposit). Short caches keep the provider bill small.
  const RPC_ALLOWED = new Set(['query', 'block', 'tx', 'EXPERIMENTAL_tx_status', 'send_tx', 'status', 'gas_price']);
  const rpcCache = new Map<string, { at: number; body: unknown }>();
  const rpcHour = { hour: 0, byIp: new Map<string, number>() };      // in memory: a DB write per read would cost more than the read
  app.post('/rpc', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: unknown; method?: string; params?: any };
    const id = body.id ?? 'cnc';
    const method = String(body.method ?? '');
    if (!deps.rpcCall || !RPC_ALLOWED.has(method)) return reply.code(400).send({ jsonrpc: '2.0', id, error: { message: 'method not allowed here' } });
    const p = body.params ?? {};
    if (method === 'query' && !['call_function', 'view_account', 'view_access_key'].includes(String(p.request_type))) {
      return reply.code(400).send({ jsonrpc: '2.0', id, error: { message: 'query type not allowed here' } });
    }
    if (method === 'send_tx' && p.wait_until && p.wait_until !== 'NONE') p.wait_until = 'NONE';
    if (method === 'tx' || method === 'EXPERIMENTAL_tx_status') p.wait_until = 'NONE';
    const hour = Math.floor(Date.now() / 3_600_000);
    if (rpcHour.hour !== hour) { rpcHour.hour = hour; rpcHour.byIp.clear(); }
    const used = (rpcHour.byIp.get(req.ip) ?? 0) + 1;
    rpcHour.byIp.set(req.ip, used);
    if (used > deps.config.rpcPerIpHour) return reply.code(429).send({ jsonrpc: '2.0', id, error: { message: 'rate limited' } });
    const ttl = method === 'block' ? 1_000 : method === 'query' && p.finality === 'final' ? 600 : 0;
    const key = ttl ? `${method}:${JSON.stringify(p)}` : '';
    const hit = key ? rpcCache.get(key) : undefined;
    if (hit && Date.now() - hit.at < ttl) return { jsonrpc: '2.0', id, result: hit.body };
    try {
      const result = await deps.rpcCall(method, p);
      if (key) {
        rpcCache.set(key, { at: Date.now(), body: result });
        if (rpcCache.size > 2_000) rpcCache.clear();
      }
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'rpc error';
      return { jsonrpc: '2.0', id, error: { message: message.slice(0, 400) } };
    }
  });

  app.post('/relay', async (req) => {
    const body = req.body as { signed_delegate?: string; wait?: boolean };
    if (!body?.signed_delegate) throw new HttpError(400, 'bad_args', 'Missing signed_delegate.');
    const height = await deps.height();
    let betMethod = false;
    const accepted = await acceptRelay({
      config: deps.config,
      store: deps.store,
      body: body.signed_delegate,
      ip: req.ip,
      height,
      broadcast: deps.broadcast,
      observe: (sender, method, args) => {
        deps.activity?.record(sender, method, args);
        if (method === 'place_bet' || method === 'blackjack_act') { betMethod = true; deps.dealer?.nudge(); }   // wake the dealer: a bet is on its way
      },
    });
    // wait: true: the server watches the transaction until it has executed and returns the outcome in this response.
    // It sits next to the RPC provider, so it polls far more cheaply than a distant browser (one round trip saved
    // per poll). If it cannot confirm within 20 s it answers without the outcome and the client watches as before.
    if (body.wait && deps.rpcCall && (accepted as { tx_hash?: string }).tx_hash) {
      const hash = (accepted as { tx_hash: string }).tx_hash;
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        try {
          const tx = await deps.rpcCall('tx', { tx_hash: hash, sender_account_id: deps.config.relayerAccount, wait_until: 'NONE' }) as any;
          const stage = String(tx?.final_execution_status ?? '');
          const pending = stage === 'NONE' || stage === 'INCLUDED' || stage === 'INCLUDED_FINAL';
          if (!pending && tx?.status && typeof tx.status === 'object' && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status || 'Failure' in tx.status)) {
            if (betMethod) deps.dealer?.scanNow();          // the bet is on chain this instant: the dealer picks it up now
            return { ...(accepted as object), tx };
          }
        } catch { /* not seen yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return accepted;
  });

  // ---- the Church oracle: moderates campaigns and attests that a player did a social/project task ----
  // Honour system for social tasks (there is no free X API): the player must open the link through the Church and
  // stay away at least VISIT_S seconds before the Father signs. Machine campaigns need no oracle (verified on chain).
  const VISIT_S = 20;
  const starts = new Map<string, number>();
  const oracleSeed = deps.config.oracleSecret ? hexToBytes(deps.config.oracleSecret) : null;
  const sign = (msg: string) => bytesToHex(ed25519.sign(new TextEncoder().encode(msg), oracleSeed!));
  const expiresNs = () => (BigInt(Date.now() + 10 * 60_000) * 1_000_000n).toString();
  const needOracle = () => { if (!oracleSeed) throw new HttpError(503, 'dealer_offline', 'The Church oracle is not configured.'); };
  const quotaOr429 = async (scope: string, id: string, max: number) => {
    const hour = new Date().toISOString().slice(0, 13);
    const q = await deps.store.quota(scope, id, hour);
    if (q.count >= max) throw new HttpError(429, 'rate_limited', 'The Church needs a rest. Try again later.', 60);
    await deps.store.addQuota(scope, id, hour, 1, 0);
  };
  app.get('/campaigns/oracle', async () => ({ oracle_pk: oracleSeed ? bytesToHex(ed25519.getPublicKey(oracleSeed)) : null, visit_s: VISIT_S }));
  /** moderation: the Father signs only campaigns that pass the Church's rules (no wallet / airdrop links, known sites) */
  app.post('/campaigns/approve', async (req) => {
    needOracle();
    const b = (req.body ?? {}) as { account_id?: string; campaign?: NewCampaign };
    const accountId = String(b.account_id ?? ''), c = b.campaign;
    if (!c || !(await deps.store.account(accountId))) throw new HttpError(400, 'bad_args', 'Play once first so your account exists.');
    const campaign: NewCampaign = {
      kind: Number(c.kind), title: String(c.title ?? ''), url: String(c.url ?? ''), machine_id: Number(c.machine_id ?? 0), goal: Number(c.goal ?? 0),
      reward_chips: Number(c.reward_chips ?? 0), reward_faith_milli: Number(c.reward_faith_milli ?? 0), max_claims: Number(c.max_claims ?? 0),
    };
    const problem = campaignProblem(campaign);
    if (problem) throw new HttpError(400, 'bad_args', problem);
    await quotaOr429('camp-approve', req.ip, 20);
    const exp = expiresNs();
    return { campaign, expires_ns: exp, approval: sign(campaignApprovalMessage(accountId, campaign, exp)) };
  });
  /** the player opens a social/project task: the visit timer starts */
  app.post('/campaigns/:id/start', async (req) => {
    const id = Number((req.params as { id: string }).id), accountId = String(((req.body ?? {}) as { account_id?: string }).account_id ?? '');
    if (!id || !(await deps.store.account(accountId))) throw new HttpError(400, 'bad_args', 'Unknown player.');
    starts.set(`${id}:${accountId}`, Date.now());
    return { visit_s: VISIT_S };
  });
  /** the player is back: if they opened the task long enough ago, the Father attests it (10-minute signature) */
  app.post('/campaigns/:id/attest', async (req) => {
    needOracle();
    const id = Number((req.params as { id: string }).id), accountId = String(((req.body ?? {}) as { account_id?: string }).account_id ?? '');
    if (!id || !(await deps.store.account(accountId))) throw new HttpError(400, 'bad_args', 'Unknown player.');
    const list = deps.view ? (await deps.view('get_campaigns', { account_id: accountId }).catch(() => [])) as { id: number; kind: number; active: boolean; claimed: boolean }[] : [];
    const c = list.find((x) => x.id === id);
    if (!c || !c.active) throw new HttpError(404, 'closed', 'That campaign has ended.');
    if (c.claimed) throw new HttpError(409, 'already_claimed', 'You already claimed this one.');
    if (c.kind === 2) throw new HttpError(400, 'bad_args', 'Machine campaigns are checked on chain; no attestation needed.');
    const at = starts.get(`${id}:${accountId}`);
    if (!at) throw new HttpError(400, 'not_done', 'Open the task first.');
    const waited = (Date.now() - at) / 1000;
    if (waited < VISIT_S) throw new HttpError(400, 'not_done', `Give it ${Math.ceil(VISIT_S - waited)} more seconds.`);
    await quotaOr429('camp-attest', accountId, 30);
    const exp = expiresNs();
    return { expires_ns: exp, attestation: sign(campaignClaimMessage(id, accountId, exp)) };
  });

  // ---- usernames: unique across the game, held by the server (not on chain) ----
  /** is this name free (or already yours)? anyone may ask; nothing is reserved by asking */
  app.get('/names/check', async (req) => {
    const q = req.query as { name?: string; account?: string };
    const name = cleanName(String(q.name ?? ''));
    const problem = nameProblem(name);
    if (problem) return { available: false, reason: problem };
    const owner = await deps.store.nameOwner(nameKey(name));
    if (owner && owner.accountId !== q.account) return { available: false, reason: 'That name is taken' };
    return { available: true };
  });
  /** your name, if you have one */
  app.get('/names/:account', async (req) => ({ name: await deps.store.nameOf((req.params as { account: string }).account) }));
  /**
   * Claim (or change to) a name. The account's own key signs `cnc-name-claim:<account>:<name>:<ts>`, so nobody can
   * take or change a name for someone else's account. Claiming a new name releases the old one.
   */
  app.post('/names', async (req) => {
    const b = (req.body ?? {}) as { account_id?: string; name?: string; ts?: number; signature?: string };
    const accountId = String(b.account_id ?? ''), name = cleanName(String(b.name ?? '')), ts = Number(b.ts);
    const problem = nameProblem(name);
    if (problem) throw new HttpError(400, 'bad_name', problem);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) throw new HttpError(400, 'bad_args', 'The claim is too old. Try again.');
    const acct = await deps.store.account(accountId);
    if (!acct) throw new HttpError(404, 'unknown_account', 'Play once first so your account exists.');
    let ok = false;
    try { ok = ed25519.verify(hexToBytes(String(b.signature ?? '')), new TextEncoder().encode(nameClaimMessage(accountId, name, ts)), hexToBytes(acct.publicKey)); } catch { ok = false; }
    if (!ok) throw new HttpError(401, 'bad_signature', 'That claim was not signed by this account.');
    const hour = new Date().toISOString().slice(0, 13);
    const q = await deps.store.quota('name', accountId, hour);
    if (q.count >= 10) throw new HttpError(429, 'rate_limited', 'Too many name changes. Try again in an hour.', 60);
    await deps.store.addQuota('name', accountId, hour, 1, 0);
    if (!(await deps.store.claimName(accountId, nameKey(name), name))) throw new HttpError(409, 'name_taken', 'That name is taken. Pick another one.');
    return { name };
  });

  app.post('/accounts', async (req) => {
    const body = req.body as { public_key?: string };
    if (!body?.public_key) throw new HttpError(400, 'bad_args', 'Missing public_key.');
    const bytes = body.public_key.startsWith('ed25519:')
      ? base58Decode(body.public_key.slice('ed25519:'.length))
      : hexToBytes(body.public_key);
    if (bytes.length !== 32) throw new HttpError(400, 'bad_args', 'Public key must be 32 bytes.');
    const accountId = bytesToHex(bytes);
    // a returning player (same browser key) is never counted against the quotas again
    if (await deps.store.account(accountId)) {
      // known here; if its funding never landed (a dropped transaction), fund it again
      if (deps.transfer && deps.balance && !(await deps.balance(accountId).then(() => true, () => false))) {
        return { account_id: accountId, tx_hash: await deps.transfer(accountId, deps.config.accountCreateYocto) };
      }
      return { account_id: accountId };
    }
    if (await deps.store.countAccounts() >= deps.config.accountsTotal) throw new HttpError(429, 'quota', 'Account creation is full.');
    const since = Date.now() - DAY;
    if (await deps.store.accountsByIpSince(req.ip, since) >= deps.config.accountsPerIpDay) {
      throw new HttpError(429, 'quota', 'Too many new accounts from this network today.');
    }
    if (deps.transfer) {
      // fund first, record after: a failed funding must not leave a "known" account that does not exist on chain
      const hash = await deps.transfer(accountId, deps.config.accountCreateYocto);
      await deps.store.insertAccount({ accountId, publicKey: bytesToHex(bytes), ip: req.ip, createdAt: Date.now() });
      return { account_id: accountId, tx_hash: hash };
    }
    const created = await deps.store.insertAccount({ accountId, publicKey: bytesToHex(bytes), ip: req.ip, createdAt: Date.now() });
    if (created && deps.config.relayerKeys.length && !deps.transfer) {
      throw new HttpError(503, 'dealer_offline', 'The relayer cannot fund accounts right now.');
    }
    return { account_id: accountId };
  });

  app.post('/faucet', async (req) => {
    const accountId = (req.body as { account_id?: string }).account_id ?? '';
    const known = await deps.store.account(accountId);
    if (!known) throw new HttpError(403, 'unknown_account', 'This wallet was not created here.');
    const since = Date.now() - DAY;
    if (await deps.store.faucetSince(accountId, since) >= 1) throw new HttpError(429, 'quota', 'The faucet already paid this account today.');
    if (await deps.store.faucetIpSince(req.ip, since) >= deps.config.faucetPerIpDay) throw new HttpError(429, 'quota', 'The faucet is busy for this network.');
    if (!deps.transfer) throw new HttpError(503, 'dealer_offline', 'The faucet is not funded.');
    // never let the faucet eat the relayer's gas money: every player's actions depend on it
    if (deps.balance && deps.config.relayerAccount) {
      const left = await deps.balance(deps.config.relayerAccount).catch(() => 0n);
      if (left < deps.config.faucetYocto + RELAYER_RESERVE) {
        console.error(JSON.stringify({ at: 'faucet', error: 'relayer balance too low for a faucet payout', relayer_near: Number(left / 10n ** 21n) / 1000 }));
        throw new HttpError(503, 'dealer_offline', 'The faucet is dry right now. Your free chips still work.');
      }
    }
    const hash = await deps.transfer(accountId, deps.config.faucetYocto);
    await deps.store.recordFaucet(accountId, req.ip, Date.now());
    return { tx_hash: hash, near: Number(deps.config.faucetYocto / 10n ** 21n) / 1000 };
  });

  return app;
}

export function implicitFromSecret(secretText: string): { accountId: string; publicKey: string } {
  const { publicKey } = keypairFromSecret(parseSecret(secretText));
  return { accountId: bytesToHex(publicKey), publicKey: publicKeyString(publicKey) };
}
