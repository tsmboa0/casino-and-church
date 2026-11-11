#!/usr/bin/env python3
"""
Builds game-ready atlases from the (git-ignored) vendor packs.

Run:  python3 -I scripts/build_assets.py
Out:  apps/client/public/assets/vendor-built/  (git-ignored)

Frame naming (Phaser multiatlas):
  cf/NNN            casino floor tile            mf/NNN       medieval floor tile
  cw/<set>/NNN      casino wall face 16x32       mw/<set>/NNN medieval wall face 16x32
  cap/NNN           wall cap 16x16
  c/<folder>/<name> casino prop                  m/<folder>/<name> medieval prop
  a/<c|m>/<folder>/<name>/<i>  animation frame
Characters are written as sheets: chars/<id>.png (+ manifest).
"""
import json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VEND = os.path.join(ROOT, "assets", "vendor")
OUT = os.path.join(ROOT, "apps", "client", "public", "assets", "vendor-built")
CAS = os.path.join(VEND, "casino-16", "Modern_Casino", "16")
_med = os.listdir(os.path.join(VEND, "medieval-16"))[0]
MED = os.path.join(VEND, "medieval-16", _med, "16")

os.makedirs(os.path.join(OUT, "chars"), exist_ok=True)
items = []          # (name, Image)
manifest = {"anims": {}, "props": {}, "chars": {}, "tile": 16}

def load(p):
    return Image.open(p).convert("RGBA")

def add_dir(prefix, d, strip_prefix=""):
    for f in sorted(os.listdir(d)):
        if f.endswith(".png"):
            n = f[:-4].replace(strip_prefix, "")
            items.append((f"{prefix}/{n.split('_')[-1] if prefix.endswith('/num') else n}", load(os.path.join(d, f))))

# ---- floors, walls, caps -------------------------------------------------
def numbered(prefix, d, strip):
    for f in sorted(os.listdir(d)):
        if f.endswith(".png"):
            num = f[:-4].split("_")[-1]
            items.append((f"{prefix}/{num}", load(os.path.join(d, f))))

ct = os.path.join(CAS, "tiles", "singles")
mt = os.path.join(MED, "tiles", "singles")
numbered("cf", os.path.join(ct, "tiles_floors"), "")
numbered("mf", os.path.join(mt, "tiles_floors"), "")
numbered("cap", os.path.join(ct, "tiles_wall_caps"), "")
numbered("mcap", os.path.join(mt, "tiles_wall_caps"), "")
for d in sorted(os.listdir(ct)):
    if d.startswith("tiles_walls_"):
        numbered(f"cw/{d[len('tiles_walls_'):]}", os.path.join(ct, d), "")
for d in sorted(os.listdir(mt)):
    if d.startswith("tiles_walls_"):
        numbered(f"mw/{d[len('tiles_walls_'):]}", os.path.join(mt, d), "")

# ---- props ----------------------------------------------------------------
def props(pk, base):
    pdir = os.path.join(base, "props")
    for folder in sorted(os.listdir(pdir)):
        for f in sorted(os.listdir(os.path.join(pdir, folder))):
            if f.endswith(".png"):
                n = f[:-4]
                im = load(os.path.join(pdir, folder, f))
                items.append((f"{pk}/{folder}/{n}", im))
                manifest["props"][f"{pk}/{folder}/{n}"] = {"w": im.width, "h": im.height}
props("c", CAS)
props("m", MED)

# ---- animated objects: cut strips into frames using the GIF's frame size ---
def anims(pk, base):
    adir = os.path.join(base, "animations", "objects")
    for folder in sorted(os.listdir(adir)):
        fd = os.path.join(adir, folder)
        for f in sorted(os.listdir(fd)):
            if not f.endswith(".png"):
                continue
            n = f[:-4]
            strip = load(os.path.join(fd, f))
            gp = os.path.join(fd, n + ".gif")
            fw, dur = strip.height, 100
            if os.path.exists(gp):
                g = Image.open(gp)
                fw = g.size[0]
                dur = g.info.get("duration", 100) or 100
            if strip.width % fw:
                print("warn: strip not divisible", pk, folder, n, strip.size, fw)
            cnt = max(1, strip.width // fw)
            key = f"{pk}/{folder}/{n}"
            manifest["anims"][key] = {"frames": cnt, "w": fw, "h": strip.height, "ms": dur}
            for i in range(cnt):
                items.append((f"a/{key}/{i}", strip.crop((i * fw, 0, (i + 1) * fw, strip.height))))
anims("c", CAS)
anims("m", MED)

# ---- Jephed casino games (free for commercial use; credit: Jephed, Game Between The Lines) ----
JEPH = os.path.join(VEND, "jephed-casino", "2D Top Down Pixel Art Tileset Casino")
if os.path.isdir(JEPH):
    sheet = load(os.path.join(JEPH, "2D_TopDown_Tileset_Casino_1024x512.png"))
    def jcrop(name, box):
        im = sheet.crop(box); items.append((f"j/{name}", im)); manifest["props"][f"j/{name}"] = {"w": im.width, "h": im.height}
    jcrop("roulette_a", (912, 132, 1024, 192))
    jcrop("roulette_b", (912, 196, 1024, 256))
    jcrop("oval", (912, 269, 1024, 352))          # two table halves, used as one round table
    jcrop("blackjack", (928, 369, 1024, 419))     # half-moon table
    for k in (0, 1):
        sh = load(os.path.join(JEPH, "Animated Sprite Sheets", f"SlotMachinesAnimationSheet_{k}.png"))
        cell = lambda i: sh.crop(((i % 8) * 32, (i // 8) * 48, (i % 8) * 32 + 32, (i // 8) * 48 + 48))
        items.append((f"j/slot{k}", cell(1))); manifest["props"][f"j/slot{k}"] = {"w": 32, "h": 48}
        for key, idxs, ms in ((f"j/slot{k}", [4, 5, 6, 7], 380), (f"j/slot{k}_spin", list(range(8, 39)), 70), (f"j/slot{k}_win", [38, 39, 38, 39], 160)):
            manifest["anims"][key] = {"frames": len(idxs), "w": 32, "h": 48, "ms": ms}
            for n, i in enumerate(idxs): items.append((f"a/{key}/{n}", cell(i)))
else:
    print("note: jephed-casino not found, skipping its games")

# ---- pack into atlas pages (shelf packer, 1px extrude) ---------------------
PAGE = 2048
PAD = 2
items.sort(key=lambda t: (-t[1].height, -t[1].width))
pages, cur = [], {"im": Image.new("RGBA", (PAGE, PAGE), (0, 0, 0, 0)), "frames": [], "x": PAD, "y": PAD, "rowh": 0}

def new_page():
    global cur
    pages.append(cur)
    cur = {"im": Image.new("RGBA", (PAGE, PAGE), (0, 0, 0, 0)), "frames": [], "x": PAD, "y": PAD, "rowh": 0}

def put(im, x, y):
    cur["im"].alpha_composite(im, (x, y))
    w, h = im.size
    # 1px extrude to avoid bleeding
    cur["im"].paste(im.crop((0, 0, w, 1)), (x, y - 1))
    cur["im"].paste(im.crop((0, h - 1, w, h)), (x, y + h))
    cur["im"].paste(im.crop((0, 0, 1, h)), (x - 1, y))
    cur["im"].paste(im.crop((w - 1, 0, w, h)), (x + w, y))

for name, im in items:
    w, h = im.size
    if cur["x"] + w + PAD > PAGE:
        cur["x"] = PAD
        cur["y"] += cur["rowh"] + PAD
        cur["rowh"] = 0
    if cur["y"] + h + PAD > PAGE:
        new_page()
    put(im, cur["x"], cur["y"])
    cur["frames"].append({"filename": name, "rotated": False, "trimmed": False,
                          "sourceSize": {"w": w, "h": h},
                          "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
                          "frame": {"x": cur["x"], "y": cur["y"], "w": w, "h": h}})
    cur["x"] += w + PAD
    cur["rowh"] = max(cur["rowh"], h + 1)
pages.append(cur)

textures = []
for i, pg in enumerate(pages):
    # crop page height to used area (power-of-two not required in WebGL2)
    used = max(f["frame"]["y"] + f["frame"]["h"] for f in pg["frames"]) + PAD + 1
    img = pg["im"].crop((0, 0, PAGE, min(PAGE, used)))
    fn = f"atlas-{i}.png"
    img.save(os.path.join(OUT, fn), optimize=True)
    textures.append({"image": fn, "format": "RGBA8888", "size": {"w": img.width, "h": img.height},
                     "scale": 1, "frames": pg["frames"]})
json.dump({"textures": textures}, open(os.path.join(OUT, "atlas.json"), "w"))
print(f"atlas: {len(items)} frames on {len(pages)} page(s)")

# ---- character sheets ------------------------------------------------------
ROWS = [("idle_down",4),("idle_left",4),("idle_right",4),("idle_up",4),
        ("walk_down",4),("walk_left",4),("walk_right",4),("walk_up",4),
        ("talk",None),("wave",None),("point_left",None),("point_right",None),("point_up",None)]
def chars(pk, base):
    cd = os.path.join(base, "animations", "cast")
    for who in sorted(os.listdir(cd)):
        d = os.path.join(cd, who)
        rows = []
        for r, _ in ROWS:
            p = os.path.join(d, r + ".png")
            if os.path.exists(p):
                im = load(p)
                g = Image.open(p[:-4] + ".gif")
                rows.append((r, im, im.width // 16, g.info.get("duration", 120) or 120))
        cols = max(n for _, _, n, _ in rows)
        sheet = Image.new("RGBA", (cols * 16, len(rows) * 32), (0, 0, 0, 0))
        meta = {}
        for ri, (r, im, n, ms) in enumerate(rows):
            sheet.alpha_composite(im, (0, ri * 32))
            meta[r] = {"row": ri, "frames": n, "ms": ms}
        cid = f"{pk}_{who}"
        sheet.save(os.path.join(OUT, "chars", cid + ".png"), optimize=True)
        manifest["chars"][cid] = {"cols": cols, "rows": meta}
chars("c", CAS)
chars("m", MED)

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
print("chars:", len(manifest["chars"]), "anims:", len(manifest["anims"]), "props:", len(manifest["props"]))
