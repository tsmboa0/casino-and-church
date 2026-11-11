/**
 * Usernames. One per account, unique across the game (server registry, not on chain).
 * Same character rules as the contract's `valid_name` (3-16 of A-Z a-z 0-9 space _ ' -).
 * Uniqueness ignores case and the separators, so "Magpie77", "magpie 77" and "Mag-pie77" are the same name.
 */
export const NAME_MIN = 3;
export const NAME_MAX = 16;
const NAME_RE = /^[A-Za-z0-9 _'-]+$/;

/** names nobody can take: the hosts, staff-sounding names */
const RESERVED = ['donfortuna', 'fortuna', 'fathernakamoto', 'nakamoto', 'father', 'admin', 'administrator', 'dealer', 'croupier', 'cashier', 'casino', 'church', 'moderator', 'support', 'system', 'official', 'near'];

export function cleanName(name: string): string { return name.trim().replace(/\s+/g, ' '); }
export function nameKey(name: string): string { return cleanName(name).toLowerCase().replace(/[ _'-]/g, ''); }

/** null when the name is fine, otherwise a short reason for the player */
export function nameProblem(name: string): string | null {
  const n = cleanName(name);
  if (n.length < NAME_MIN) return `At least ${NAME_MIN} characters`;
  if (n.length > NAME_MAX) return `At most ${NAME_MAX} characters`;
  if (!NAME_RE.test(n)) return 'Letters, numbers, spaces, _ - and \' only';
  const key = nameKey(n);
  if (key.length < 2) return 'Use some letters or numbers';
  if (RESERVED.includes(key)) return 'That name is reserved';
  return null;
}

/** the exact text a player's key signs to claim a name (the server rejects stale timestamps) */
export function nameClaimMessage(accountId: string, name: string, ts: number): string {
  return `cnc-name-claim:${accountId}:${cleanName(name)}:${ts}`;
}
