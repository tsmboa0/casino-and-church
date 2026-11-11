#!/usr/bin/env python3
"""Reference maths + conformance vectors for the game tables in BACKEND_PLAN.md.
Run:  python3 -I scripts/rtp_check.py
The Rust contract and the TypeScript mirror (apps/client/src/core/rules.ts) must reproduce every number here."""
import hashlib
from fractions import Fraction as F

# ---- canonical tables -------------------------------------------------------------------------
SLOT_SYMS = ["seven", "diamond", "clover", "coin", "cross"]
SLOT_W    = [4, 8, 14, 24, 50]            # per 100
SLOT_TRIPLE = {"seven": 100, "diamond": 40, "clover": 15, "coin": 8, "cross": 3}   # x wager
SLOT_PAIR = 1                              # x wager when exactly two ADJACENT reels match (0-1 or 1-2, not a triple)
COIN_PAY_BPS = 19400
DICE_OVER_UNDER_BPS = 22800                # sum 8..12 (over) or 2..6 (under): 15/36 each
DICE_SEVEN_BPS = 57000                     # sum == 7: 6/36
ROUL_RED = {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36}
WHEEL = [(10,30),(25,30),(50,20),(100,15),(250,4),(500,1)]          # (prize chips, weight per 100)
HARMONY = [(150,40),(300,30),(600,20),(1500,9),("JACKPOT",1)]

def slots_rtp():
    p = [F(w,100) for w in SLOT_W]
    triple = sum(SLOT_TRIPLE[s]*pi**3 for s,pi in zip(SLOT_SYMS,p))
    p3 = sum(pi**3 for pi in p); p2 = sum(pi**2 for pi in p)
    pair_only = (2*p2 - p3) - p3          # r0==r1 or r1==r2, minus the triple case
    return triple + SLOT_PAIR*pair_only, triple, pair_only, (2*p2 - p3)

def mulshift(draw, n): return (draw * n) >> 32
def draws(h): return [int.from_bytes(h[4*k:4*k+4], "little") for k in range(8)]
def h_of(server_seed, client_seed, chain_seed, bet_id):
    return hashlib.sha256(server_seed + client_seed + chain_seed + bet_id.to_bytes(8, "little")).digest()
def slot_reels(h):
    d = draws(h); out = []
    for k in range(3):
        r = mulshift(d[k], 100); acc = 0
        for s, w in zip(SLOT_SYMS, SLOT_W):
            acc += w
            if r < acc: out.append(s); break
    return out
def slot_pay_x(reels):
    a,b,c = reels
    if a == b == c: return SLOT_TRIPLE[a]
    if a == b or b == c: return SLOT_PAIR
    return 0

def coin_side(h):
    return "H" if mulshift(draws(h)[0], 2) == 0 else "T"

def dice_faces(h):
    d = draws(h)
    return [mulshift(d[0], 6) + 1, mulshift(d[1], 6) + 1]

def roulette_n(h):
    return mulshift(draws(h)[0], 37)

def roulette_color(n):
    if n == 0: return "green"
    return "red" if n in ROUL_RED else "black"

def wheel_prize(h):
    r = mulshift(draws(h)[0], 100); acc = 0
    for prize, w in WHEEL:
        acc += w
        if r < acc: return prize
    return WHEEL[-1][0]

def harmony_prize(h):
    r = mulshift(draws(h)[0], 100); acc = 0
    for prize, w in HARMONY:
        acc += w
        if r < acc: return prize
    return HARMONY[-1][0]

def vector_case(server, client, chain, bet_id):
    h = h_of(server, client, chain, bet_id)
    reels = slot_reels(h)
    n = roulette_n(h)
    prize = harmony_prize(h)
    return {
        "server": server.hex(),
        "client": client.hex(),
        "chain": chain.hex(),
        "bet_id": bet_id,
        "h": h.hex(),
        "commit": hashlib.sha256(server).hexdigest(),
        "slots": reels,
        "slots_pay_x": slot_pay_x(reels),
        "coin": coin_side(h),
        "dice": dice_faces(h),
        "roulette_n": n,
        "roulette_color": roulette_color(n),
        "wheel": wheel_prize(h),
        "harmony": prize if prize != "JACKPOT" else "JACKPOT",
    }

def emit_vectors(n, path):
    import json, random
    ss, cs, ch = b"\x11"*32, b"\x22"*32, b"\x33"*32
    fixed = [vector_case(ss, cs, ch, i) for i in (1, 2, 3, 4, 5)]
    rng = random.Random(20261110)
    rand = []
    for i in range(n):
        server = bytes(rng.getrandbits(8) for _ in range(32))
        client = bytes(rng.getrandbits(8) for _ in range(32))
        chain = bytes(rng.getrandbits(8) for _ in range(32))
        rand.append(vector_case(server, client, chain, i + 1))
    doc = {"version": 1, "fixed": fixed, "random": rand}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {len(fixed)} fixed + {len(rand)} random vectors -> {path}")

if __name__ == "__main__":
    import argparse, os
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit-vectors", type=int, metavar="N", help="write N random vectors plus the §6.6 fixed set")
    ap.add_argument("--out", default=os.path.join(root, "contracts", "realm", "vectors.json"))
    args = ap.parse_args()
    rtp, tr, pr, anyp = slots_rtp()
    print(f"slots   RTP = {float(rtp):.4%}   (triples {float(tr):.4%} + pairs {float(pr):.4%}; hit rate {float(anyp):.2%})")
    print(f"coin    RTP = {0.5*COIN_PAY_BPS/10000:.2%}")
    print(f"dice    over/under RTP = {15/36*DICE_OVER_UNDER_BPS/10000:.2%}   seven RTP = {6/36*DICE_SEVEN_BPS/10000:.2%}")
    print(f"roulette (single zero) even-money RTP = {18/37*2:.2%}   straight-up RTP = {36/37:.2%}")
    wm = sum(p*w/100 for p,w in WHEEL); print(f"wheel   mean prize = {wm:.1f} chips")
    hm = sum(p*w/100 for p,w in HARMONY if p != 'JACKPOT'); print(f"harmony mean (excl. jackpot) = {hm:.1f} chips + 1% x jackpot pool")
    print("\nCONFORMANCE VECTORS (server_seed = 32x 0x11, client_seed = 32x 0x22, chain_seed = 32x 0x33)")
    ss, cs, ch = b"\x11"*32, b"\x22"*32, b"\x33"*32
    for bet_id in (1, 2, 3, 4, 5):
        h = h_of(ss, cs, ch, bet_id); reels = slot_reels(h); d = draws(h)
        print(f"bet_id={bet_id} h={h.hex()}")
        print(f"   slots={reels} pay={slot_pay_x(reels)}x | coin={'H' if mulshift(d[0],2)==0 else 'T'} | dice={mulshift(d[0],6)+1},{mulshift(d[1],6)+1} | roulette={mulshift(d[0],37)}")
    print("commit =", hashlib.sha256(ss).hexdigest())
    if args.emit_vectors is not None:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        emit_vectors(args.emit_vectors, args.out)
