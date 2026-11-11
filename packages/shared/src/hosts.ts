/**
 * The two hosts' offline answers and the relevance vocabulary (BACKEND_PLAN R3-9).
 * Shared by the client's offline mock and the server's relevance gate (a question with none of these words,
 * and no greeting, is refused without calling the model).
 * Each row: [keywords (matched at word starts), Don Fortuna's answer, Father Nakamoto's answer].
 */
export type HostId = 'fortuna' | 'nakamoto';

export const HOST_FAQ: [string[], string, string][] = [
  [["hello", "hi ", "hey", "good evening", "how are you"], "Welcome to my house. Ask me anything about the games, your LUCK, or what I am planning.", "Peace be with you. Ask me about FAITH, the candles, or what the Church is doing tonight."],
  [["odds", "win", "best game", "strategy", "tips"], "Best odds on my floor: the Coin Flip, 1.94 to one. The slots can pay a hundred to one if the reels like you. The house still has an edge. Bet what you can lose.", "I will not tell you how to beat the Casino. I will tell you that FAITH raises every payout through the blessing. Tithe, light candles, and the house pays you a little more."],
  [["luck"], "Every bet fills your LUCK. Fill it to 100 and my Wheel of Fortune spins for you. Stay too long in the Church and it drains.", "LUCK is the Casino's gift. Offer it at the altar and it becomes FAITH, eight parts in ten."],
  [["faith", "bless"], "FAITH is the Father's business. It fades while you are in here, so pay him a visit, then come back.", "FAITH grows with tithes, candles and offerings at the altar. The higher it is, the bigger your blessing on every Casino win."],
  [["harmony", "jackpot", "balance"], "Keep LUCK and FAITH both above fifty and the Harmony Wheel at the Crossroads opens. The jackpot pool lives there.", "Balance is survival. Keep both above fifty and the Harmony Wheel at the Crossroads will turn for you."],
  [["happy hour", "vigil", "event"], "When my floor is quiet I call a Happy Hour: every bet fills LUCK faster for a while. Payouts never change.", "When the dice get too loud I call a Vigil: candles and tithes give more FAITH for a while."],
  [["cashier", "chips", "deposit", "withdraw", "near", "money"], "The Cashier by the door changes NEAR into chips, a hundred to one. Cash out whenever you like. Testnet money only.", "Chips come from the Cashier in the Casino. The Church only asks for what you choose to give."],
  [["fair", "rigged", "cheat", "random", "trust", "verify", "honest"], "Every bet is dealt by commit-reveal: my sealed secret, your seed and the chain's. Neither of us can bend it. And every rule I set is signed and on chain.", "The Church keeps no secrets. Every decision I make is signed in secure hardware and anchored on chain. Tap VERIFY and see for yourself."],
  [["plot", "machine", "own", "deed"], "Founders' Row, south of the floor. Earn your standing and a plot is yours: your name on the deed, your machine on my floor.", "Ask Don Fortuna about the plots. The Church owns nothing but candles and patience."],
  [["slot", "roulette", "dice", "blackjack", "coin", "wheel", "game", "table"], "Slots, Coin Flip, Roulette, Dice and Blackjack are all open. Walk up, pick a chip, play. Every result can be checked.", "The games are across the Crossroads. I only ask that you come back before your FAITH runs dry."],
  [["candle", "tithe", "offering", "altar", "quest", "alms", "sermon", "pray"], "Candles and tithes are the Father's trade. I deal in reels and dice.", "Light a candle once a day, tithe at the Offering Box, finish a quest at the board by the door. The poor get alms when they run dry."],
  [["father", "nakamoto", "church", "priest"], "The Father and I keep each other honest. He has his candles, I have my neon. The players choose.", "I speak with my own voice, child."],
  [["don", "fortuna", "casino", "owner", "boss"], "I speak for myself, friend.", "Don Fortuna runs a fair house, for a house. We compete for your time. Balance is survival."],
  [["monitor", "vault", "ledger", "treasury", "stats"], "The screens outside my door show the vault, the floor and every rule I set.", "The Ledger beside my door shows the treasury, the tithes and every sermon."],
];

export const HOST_REFUSAL: Record<HostId, string> = {
  fortuna: 'I only talk shop in my house. Ask me about the games, your LUCK, the Wheel, or what I am planning.',
  nakamoto: 'That is beyond the walls of this game, child. Ask me about FAITH, the candles, the quests or the Harmony Wheel.',
};

const escape = (s: string) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** keywords match at word starts, so 'own' does not match 'town' */
function hasWord(q: string, words: string[]): boolean {
  return words.some((w) => new RegExp(`\\b${escape(w)}`).test(q));
}

/** The canned answer for a question, or null when nothing in the game vocabulary matches. */
export function faqAnswer(agent: HostId, question: string): string | null {
  const q = question.toLowerCase();
  for (const [keys, don, father] of HOST_FAQ) if (hasWord(q, keys)) return agent === 'fortuna' ? don : father;
  return null;
}

/** Extra words that make a question about this game even when no FAQ row matches. */
const EXTRA_VOCAB = ['bet', 'spin', 'payout', 'pay', 'play', 'rule', 'reward', 'prize', 'meter', 'decay', 'quest', 'mission',
  'house', 'edge', 'rtp', 'proof', 'signature', 'attest', 'agent', 'decision', 'plan', 'doing', 'up to', 'latest', 'crossroads',
  'gate', 'tour', 'cooldown', 'limit', 'max bet', 'testnet', 'wallet', 'gas', 'relayer',
  'floor', 'table', 'game', 'chip', 'win', 'lose', 'lost', 'money', 'odds', 'chance', 'fair', 'cheat', 'rig', 'tonight', 'today',
  'change', 'decide', 'why', 'hello', 'hi', 'hey', 'who are', 'tell me', 'advice', 'tip', 'help', 'strategy', 'best'];
/** Talking TO the host ("what did you change?", "why are you...") is on topic; the model still refuses off-topic content. */
const ADDRESSED = /\b(you|your|yours|yourself)\b/;

/** Cheap pre-filter: true when the question uses the game's vocabulary or is a greeting. */
export function onTopic(question: string): boolean {
  const q = question.toLowerCase();
  return HOST_FAQ.some(([keys]) => hasWord(q, keys)) || hasWord(q, EXTRA_VOCAB) || ADDRESSED.test(q);
}
