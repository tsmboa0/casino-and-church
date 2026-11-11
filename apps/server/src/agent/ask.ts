import { HOST_REFUSAL, faqAnswer, onTopic, type HostId } from '@cnc/shared';
import type { AttestationRow, Store } from '../db/store.ts';
import { HttpError } from '../http.ts';
import type { NearAI, TokenBudget } from './nearai.ts';
import { chatSystem } from './persona.ts';
import { lineProblem, parseReply } from './policy-check.ts';
import { checkProof } from './verify.ts';

/**
 * Talking to a host (R3-9). A separate persona call with NO tools: it can never act, never touches the decision
 * loop, and its text never goes into a decision prompt. Two relevance layers: a vocabulary pre-filter (no model
 * call), then the model's own judgement under a rules-of-the-game system prompt.
 */
export interface AskProof {
  model: string; chatId: string; signedText: string; signature: string; signingAddress: string;
  signatureKind: 'provider_tee' | 'gateway'; requestB64: string; responseB64: string; attestedSigner: string; attestationAt: number;
}
export interface AskResult { answer: string; relevant: boolean; proof?: AskProof; source: 'model' | 'faq' | 'filter' }

const hourBucket = () => `h:${new Date().toISOString().slice(0, 13)}`;

export async function askHost(opts: {
  agent: HostId;
  question: string;
  account: string;
  ip: string;
  store: Store;
  ai: NearAI | null;
  budget: TokenBudget;
  perAccountHour: number;
  perIpHour: number;
  state: () => Promise<unknown>;
  attestation: () => Promise<AttestationRow | null>;
}): Promise<AskResult> {
  const { agent, store } = opts;
  const q = String(opts.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) throw new HttpError(400, 'bad_args', 'Ask a question.');

  const bucket = hourBucket();
  const who = opts.account || `ip:${opts.ip}`;
  const [acc, ip] = await Promise.all([store.quota('ask', who, bucket), store.quota('ask-ip', opts.ip, bucket)]);
  if (acc.count >= opts.perAccountHour || ip.count >= opts.perIpHour) {
    throw new HttpError(429, 'rate_limited', agent === 'fortuna' ? 'Enough questions for now, friend. Come back in an hour.' : 'Rest a while, child. Ask me again within the hour.', 60);
  }
  await Promise.all([store.addQuota('ask', who, bucket, 1, 0), store.addQuota('ask-ip', opts.ip, bucket, 1, 0)]);

  const refuse = (): AskResult => ({ answer: HOST_REFUSAL[agent], relevant: false, source: 'filter' });
  if (/<[a-z/!]|https?:|www\./i.test(q)) return refuse();
  if (!onTopic(q)) return refuse();

  const faq = (): AskResult => {
    const hit = faqAnswer(agent, q);
    return hit ? { answer: hit, relevant: true, source: 'faq' } : { answer: HOST_REFUSAL[agent], relevant: false, source: 'faq' };
  };
  const ai = opts.ai;
  if (!ai?.enabled || !opts.budget.canSpend('chat')) return faq();

  let cap;
  try {
    const state = await opts.state().catch(() => ({}));
    cap = await ai.chat(
      [{ role: 'system', content: chatSystem(agent) }, { role: 'user', content: JSON.stringify({ state, question: q }) }],
      { maxTokens: 220, temperature: 0.5, timeoutMs: 15_000 },
    );
  } catch (err) {
    console.error(JSON.stringify({ at: 'ask', agent, fallback: 'model_error', error: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
    return faq();
  }
  opts.budget.spend('chat', cap.tokens || 400);
  const reply = parseReply(cap.content) as { relevant?: unknown; answer?: unknown } | null;
  if (!reply || typeof reply.answer !== 'string' || typeof reply.relevant !== 'boolean') {
    console.error(JSON.stringify({ at: 'ask', agent, fallback: 'bad_reply', raw: String(cap.content).slice(0, 300) }));
    return faq();
  }
  if (!reply.relevant) return refuse();
  const problem = lineProblem(reply.answer, 280);
  if (problem) { console.error(JSON.stringify({ at: 'ask', agent, fallback: 'line_rejected', problem, answer: reply.answer.slice(0, 300) })); return faq(); }

  const result: AskResult = { answer: reply.answer.trim(), relevant: true, source: 'model' };
  // a signed answer is a bonus: never hold the reply more than ~3 s for it
  const [sig, att] = await Promise.all([ai.signature(cap.chatId, 3_000), opts.attestation()]);
  if (sig && att) {
    const check = checkProof({ model: ai.model, request: cap.request, response: cap.response, signature: sig, attestedSigner: att.signingAddress });
    if (check.ok) {
      result.proof = {
        model: ai.model, chatId: cap.chatId, signedText: sig.text, signature: sig.signature, signingAddress: sig.signing_address,
        signatureKind: (sig.signature_kind === 'gateway' ? 'gateway' : 'provider_tee'), requestB64: cap.request.toString('base64'),
        responseB64: cap.response.toString('base64'), attestedSigner: att.signingAddress, attestationAt: att.at,
      };
    }
  }
  return result;
}
