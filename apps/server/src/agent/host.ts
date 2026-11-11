import { randomUUID } from 'node:crypto';
import { TGAS, type HostId } from '@cnc/shared';
import type { AttestationRow, HostDecisionRow, Store } from '../db/store.ts';
import type { KeyPool } from '../near/pool.ts';
import type { NearRpc } from '../near/rpc.ts';
import { panicCode, txSucceeded } from '../near/rpc.ts';
import type { Activity } from './activity.ts';
import type { NearAI, TokenBudget } from './nearai.ts';
import { forModel, observe, type Snapshot } from './observe.ts';
import { decisionSystem, templateLine } from './persona.ts';
import { DECISION_LINE_MAX, checkDecision, lineProblem, parseReply, type Plan } from './policy-check.ts';
import { newRuleMemory, rulesDecide } from './rules.ts';
import { checkProof } from './verify.ts';

export interface HostDeps {
  rpc: NearRpc;
  store: Store;
  activity: Activity;
  ai: NearAI | null;
  budget: TokenBudget;
  /** the key pool that signs as this host's account (Don: boss, Father: priest); null = observe only */
  pool: KeyPool | null;
  attestation: () => Promise<AttestationRow | null>;
  publish: (row: HostDecisionRow, eventsChanged: boolean) => void;
}

/**
 * One AI host. A cycle is: observe -> decide (NEAR AI, or the rule fallback) -> guardrails -> proof gate -> act.
 * An applied model decision is ONE contract call, `host_act(proof, call)`: the chain either has the anchored proof
 * and the action together, or neither.
 */
export class Host {
  private memory = newRuleMemory();
  private busy = false;
  lastCycleAt = 0;
  lastSnapshot: Snapshot | null = null;
  lastError: string | null = null;

  constructor(readonly agent: HostId, private deps: HostDeps) {}

  async cycle(trigger: string): Promise<HostDecisionRow | null> {
    if (this.busy) return null;
    this.busy = true;
    this.lastCycleAt = Date.now();
    try {
      const snap = await observe(this.deps, this.agent);
      this.lastSnapshot = snap;
      const row = await this.decide(snap, trigger);
      await this.deps.store.addHostDecision(row);
      this.deps.publish(row, row.applied && /^(start|end)_/.test(row.action));
      this.lastError = null;
      console.log(JSON.stringify({ at: 'host', agent: this.agent, trigger, policy: row.policy, action: row.action, applied: row.applied, reason: row.reason, tx: row.txHash }));
      return row;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ at: 'host', agent: this.agent, error: this.lastError }));
      return null;
    } finally {
      this.busy = false;
    }
  }

  private base(snap: Snapshot, policy: 'llm' | 'rules'): HostDecisionRow {
    const { alias_to_account: _hidden, ...observation } = snap;
    return {
      id: randomUUID(), agent: this.agent, at: Date.now(), policy, observation, action: 'none', params: {}, line: '',
      applied: false, reason: null, txHash: null, model: null, chatId: null, requestB64: null, responseB64: null,
      signedText: null, signature: null, signingAddress: null, signatureKind: null, attestationId: null, tokens: 0,
    };
  }

  private async decide(snap: Snapshot, trigger: string): Promise<HostDecisionRow> {
    const { ai, budget } = this.deps;
    if (ai?.enabled && budget.canSpend('decide')) {
      try {
        return await this.decideWithModel(snap, trigger);
      } catch (err) {
        const row = await this.decideWithRules(snap);
        row.reason = `model unavailable (${err instanceof Error ? err.message.slice(0, 80) : 'error'}); rule fallback`;
        return row;
      }
    }
    const row = await this.decideWithRules(snap);
    if (!row.reason) row.reason = ai?.enabled ? 'daily token budget reached; rule fallback' : 'model disabled; rule fallback';
    return row;
  }

  private async decideWithRules(snap: Snapshot): Promise<HostDecisionRow> {
    const row = this.base(snap, 'rules');
    const plan = rulesDecide(this.agent, snap, this.memory);
    this.fill(row, plan, snap);
    if (!plan.calls.length) { row.applied = true; return row; }
    return this.act(row, plan.calls);
  }

  private async decideWithModel(snap: Snapshot, trigger: string): Promise<HostDecisionRow> {
    const ai = this.deps.ai!;
    const row = this.base(snap, 'llm');
    const user = JSON.stringify({ trigger, ...forModel(snap, this.agent) });
    const cap = await ai.chat([{ role: 'system', content: decisionSystem(this.agent) }, { role: 'user', content: user }], { maxTokens: 200, temperature: 0.3 });
    this.deps.budget.spend('decide', cap.tokens || 400);
    row.model = ai.model;
    row.chatId = cap.chatId;
    row.requestB64 = cap.request.toString('base64');
    row.responseB64 = cap.response.toString('base64');
    row.tokens = cap.tokens;

    const raw = parseReply(cap.content);
    const checked = checkDecision(this.agent, raw, snap);

    // proof gate: the enclave signature over our exact bytes, from the attested key
    const [sig, att] = await Promise.all([ai.signature(cap.chatId, 10_000), this.deps.attestation()]);
    if (sig) {
      row.signedText = sig.text;
      row.signature = sig.signature;
      row.signingAddress = sig.signing_address;
      row.signatureKind = sig.signature_kind ?? 'provider_tee';
    }
    row.attestationId = att?.id ?? null;
    const proof = sig ? checkProof({ model: ai.model, request: cap.request, response: cap.response, signature: sig, attestedSigner: att?.signingAddress ?? null }) : null;

    if (!checked.ok) {
      // the model asked for something the guardrails refuse: nothing happens, and we say why
      row.action = typeof raw?.action === 'string' ? raw.action.slice(0, 40) : 'invalid';
      row.params = sanitizeParams(raw?.params);
      row.line = templateLine(this.agent, 'none', snap.at);
      row.reason = `guardrail: ${checked.reason}`;
      return row;
    }
    this.fill(row, checked.plan, snap);
    if (!sig) { row.reason = 'unsigned: no signature from the enclave within 10 s'; return row; }
    if (!proof!.ok) { row.reason = `proof failed: ${proof!.reasons.join('; ')}`; return row; }
    if (!this.deps.pool) { row.reason = 'no signing key for this host on the server'; return row; }

    // ONE function call: the contract emits the signed proof and performs the action, or does neither.
    // (A function-call access key may sign only one action per transaction, so this cannot be two actions.)
    const proofArgs = {
      decision_id: row.id, agent: this.agent, action: checked.plan.action, model: ai.model,
      signed_text: sig.text, signature: sig.signature.replace(/^0x/, ''), signing_address: sig.signing_address,
      request_sha256: proof!.requestSha256, response_sha256: proof!.responseSha256,
    };
    return this.act(row, [{ method: 'host_act', args: { proof: proofArgs, call: hostCall(checked.plan.calls[0]) }, gas: 60n * TGAS }]);
  }

  private fill(row: HostDecisionRow, plan: Plan, snap: Snapshot) {
    row.action = plan.action;
    row.params = { ...plan.params };
    if (plan.action === 'grant_alms') {
      const alias = String(plan.params.account ?? '');
      row.params = { chips: plan.params.chips! };
      row.params.player = snap.alias_to_account[alias] ?? '';      // stored, never sent to clients
    }
    row.line = lineProblem(plan.line, DECISION_LINE_MAX) ? templateLine(this.agent, plan.action, snap.at) : plan.line;
  }

  private async act(row: HostDecisionRow, calls: { method: string; args: unknown; gas: bigint }[]): Promise<HostDecisionRow> {
    if (!this.deps.pool) { row.reason = row.reason ?? 'no signing key for this host on the server'; return row; }
    try {
      const sent = await this.deps.pool.callsAndWait(calls);
      row.txHash = sent.hash;
      if (txSucceeded(sent.tx)) row.applied = true;
      else row.reason = `contract refused: ${panicCode(sent.tx) ?? 'failed'}`;
    } catch (err) {
      row.reason = `transaction failed: ${explainTxError(err)}`;
    }
    return row;
  }
}

/** the useful part of a rejected transaction (the RPC wraps it in several layers of JSON) */
export function explainTxError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/MethodNameMismatch|RequiresFullAccess|ReceiverMismatch/.test(m)) return "this host's key may not call that method (run scripts/host-keys.mjs)";
  if (/MethodNotFound|MethodResolveError/.test(m)) return 'the contract has no such method yet (run scripts/upgrade.mjs)';
  if (/NotEnoughAllowance/.test(m)) return "the host key's allowance is spent";
  if (/InvalidNonce/.test(m)) return 'nonce race; retried next cycle';
  const inner = m.match(/"(InvalidAccessKeyError|ActionError|InvalidTxError)":\{"?([A-Za-z]+)/);
  return inner ? `${inner[1]}: ${inner[2]}` : m.slice(0, 120);
}

/** a planned contract call as `host_act`'s HostCall (`{"do": method, ...args}`; the arg names already match) */
export function hostCall(c: { method: string; args: unknown } | undefined): Record<string, unknown> {
  return c ? { do: c.method, ...(c.args as Record<string, unknown>) } : { do: 'none' };
}

function sanitizeParams(p: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!p || typeof p !== 'object') return out;
  for (const [k, v] of Object.entries(p as Record<string, unknown>).slice(0, 4)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k.slice(0, 24)] = v;
    else if (typeof v === 'string') out[k.slice(0, 24)] = v.slice(0, 24);
  }
  return out;
}
