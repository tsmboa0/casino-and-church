/** One-line history text. The cashier shows this string; it is stored with the bet. */
export function betDetail(game: string, outcome: any): string {
  const name = String(game || '').toLowerCase();
  if (!outcome) return name.toUpperCase();
  if (name === 'slots' || name.includes('slot')) {
    return (outcome.reels ?? []).map((reel: string) => String(reel).toUpperCase()).join(' ');
  }
  if (name === 'coin' || name === 'coinflip') return outcome.side === 'T' ? 'TAILS' : 'HEADS';
  if (name === 'dice' && Array.isArray(outcome.dice)) {
    const [a, b] = outcome.dice as number[];
    return `${a} + ${b} = ${Number(a) + Number(b)}`;
  }
  if (name === 'roulette') return `${outcome.n} ${String(outcome.color ?? '').toUpperCase()}`.trim();
  if (name === 'wheel') return `WHEEL ${outcome.prize ?? ''}`.trim();
  if (name === 'harmony') return outcome.prize === 'JACKPOT' ? 'JACKPOT' : `HARMONY ${outcome.prize ?? ''}`.trim();
  if (name === 'blackjack') {
    const player = (outcome.reels ?? []).join(' ');
    const dealer = (outcome.dealer_cards ?? []).join(' ');
    return dealer ? `${player} v ${dealer}` : player;
  }
  if (name === 'market') {
    // reels = [lock price, close price], side = the player's call, color = the round's outcome
    const [lock, close] = (outcome.reels ?? []) as string[];
    const call = String(outcome.side ?? '').toUpperCase();
    const res = String(outcome.color ?? '').toUpperCase();
    if (res === 'VOID') return `BTC ${call} · VOID (refunded)`;
    if (res === 'TIE') return `BTC ${call} · TIE $${lock} (refunded)`;
    return `BTC ${call} · $${lock} → $${close}`;
  }
  return name.toUpperCase();
}
