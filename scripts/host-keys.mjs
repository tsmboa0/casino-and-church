#!/usr/bin/env node
/**
 * Function-call keys for the two AI hosts, so the server can sign their decisions:
 *   Don Fortuna     -> AGENT_KEYS  on DEALER_ACCOUNT (boss.*), since the dealer keys only allow the dealer's methods
 *   Father Nakamoto -> PRIEST_KEYS on PRIEST_ACCOUNT (priest.*)
 * Generates the keys locally, appends them to .env.local (secrets are never printed), and prints the near-cli-rs
 * commands that add the PUBLIC keys, restricted to the realm contract and to each host's methods only.
 * Run those commands with each account's full-access key (keychain), then restart the server.
 *
 *   apps/server/node_modules/.bin/tsx scripts/host-keys.mjs [keys per host = 2]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const shared = await import('../packages/shared/src/index.ts');
const envPath = new URL('../.env.local', import.meta.url);
const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const contract = get('REALM_CONTRACT');
const n = Math.max(1, Math.min(4, Number(process.argv[2] ?? 2)));
const HOSTS = [
  { env: 'AGENT_KEYS', account: get('DEALER_ACCOUNT'), who: 'Don Fortuna', methods: 'host_act, set_params, start_event, end_event, top_up_jackpot' },
  { env: 'PRIEST_KEYS', account: get('PRIEST_ACCOUNT'), who: 'Father Nakamoto', methods: 'host_act, start_event, end_event, grant_alms, set_church_params' },
];
if (!contract) { console.error('Set REALM_CONTRACT in .env.local first.'); process.exit(1); }

const commands = [];
for (const h of HOSTS) {
  if (!h.account) { console.log(`skip ${h.who}: no account in .env.local`); continue; }
  if (get(h.env)) { console.log(`skip ${h.who}: ${h.env} is already set (remove it to make new keys)`); continue; }
  const secrets = [], publics = [];
  for (let i = 0; i < n; i++) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const { publicKey } = shared.keypairFromSecret(secret);
    const full = new Uint8Array(64); full.set(secret, 0); full.set(publicKey, 32);
    secrets.push(`ed25519:${shared.base58Encode(full)}`);
    publics.push(shared.publicKeyString(publicKey));
  }
  appendFileSync(envPath, `\n# ${h.who}: function-call keys on ${h.account} (${h.methods}). Public: ${publics.join(' ')}\n${h.env}=${secrets.join(',')}\n`);
  console.log(`wrote ${h.env} (${n} keys) for ${h.who} to .env.local`);
  for (const pk of publics) {
    commands.push(`near account add-key ${h.account} grant-function-call-access --allowance '1 NEAR' --contract-account-id ${contract} --function-names '${h.methods}' use-manually-provided-public-key ${pk} network-config testnet sign-with-keychain send`);
  }
}
if (commands.length) console.log(`\nNow add the public keys on chain:\n\n${commands.join('\n\n')}\n\nThen restart the server; /healthz -> agents shows both hosts.`);
