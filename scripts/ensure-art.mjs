#!/usr/bin/env node
/**
 * The game's art comes from licensed packs that may not be shared, so it is not in this repository
 * (apps/client/public/assets/vendor-built/ is git-ignored). This runs before `dev` and `build`:
 *  - if the real art is there, it does nothing;
 *  - if not (a fresh clone), it draws PLACEHOLDER art from apps/client/art-skeleton.json (sprite names and sizes only):
 *    coloured, outlined boxes for every prop and tile, little walking figures for every character. The whole game then
 *    runs and plays normally, just plainer. The game shows a banner pointing to the live version with the real art.
 * Pure Node (zlib for PNG), no dependencies.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const out = new URL('../apps/client/public/assets/vendor-built/', import.meta.url);
if (existsSync(new URL('manifest.json', out)) && !process.argv.includes('--force')) process.exit(0);
const skel = JSON.parse(readFileSync(new URL('../apps/client/art-skeleton.json', import.meta.url), 'utf8'));
mkdirSync(new URL('chars/', out), { recursive: true });

// ---------------------------------------------------------------- a tiny RGBA canvas + PNG encoder
class Img {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8Array(w * h * 4); }
  px(x, y, c) { if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = (y * this.w + x) * 4; this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = c[3] ?? 255; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  png() {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) { raw[y * (this.w * 4 + 1)] = 0; Buffer.from(this.d.buffer, y * this.w * 4, this.w * 4).copy(raw, y * (this.w * 4 + 1) + 1); }
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return c ^ 0xffffffff; }
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const shade = (c, k) => [Math.min(255, Math.round(c[0] * k)), Math.min(255, Math.round(c[1] * k)), Math.min(255, Math.round(c[2] * k)), 255];

// ---------------------------------------------------------------- colours by family (casino reds/golds, church stone/wood)
function palette(name) {
  const v = hash(name) % 5;
  // floors: one tone per realm (casino carpet, church stone), each tile variant a shade lighter or darker
  if (name.startsWith('cf/')) return { fill: shade([120, 28, 54], 0.9 + v * 0.04), tile: true };
  if (name.startsWith('mf/')) return { fill: shade([140, 128, 106], 0.92 + v * 0.035), tile: true };
  if (name.startsWith('cw/')) return { fill: [80, 30, 70], wall: true };
  if (name.startsWith('mw/')) return { fill: [120, 106, 86], wall: true };
  if (name.startsWith('j/')) return { fill: [24, 110, 70] };                       // tables, slots
  if (name.startsWith('c/')) return { fill: [[170, 40, 90], [200, 150, 60], [90, 50, 140], [40, 90, 150], [150, 60, 60]][v] };
  if (name.startsWith('m/')) return { fill: [[120, 80, 44], [150, 110, 64], [100, 90, 80], [140, 60, 50], [90, 110, 70]][v] };
  return { fill: [110, 110, 130] };
}
function drawFrame(img, x, y, w, h, name) {
  const p = palette(name), c = p.fill, dark = shade(c, 0.55), light = shade(c, 1.25);
  if (p.tile) {                                                                     // floors: flat with a faint grid
    img.rect(x, y, w, h, c); img.rect(x, y, w, 1, shade(c, 1.08)); img.rect(x, y, 1, h, shade(c, 1.08));
    return;
  }
  if (p.wall) { img.rect(x, y, w, h, c); for (let j = 3; j < h; j += 6) img.rect(x, y + j, w, 1, dark); return; }
  img.rect(x, y, w, h, [0, 0, 0, 0]);
  img.rect(x, y, w, h, dark); img.rect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2), c);
  img.rect(x + 1, y + 1, Math.max(0, w - 2), 1, light);                            // a top highlight
  if (w >= 8 && h >= 8) img.rect(x + Math.floor(w / 2) - 1, y + Math.floor(h / 2) - 1, 2, 2, light);
}

// ---------------------------------------------------------------- the atlas: shelf-pack every frame into one sheet
const W = 2048, PAD = 1;
let cx = PAD, cy = PAD, shelf = 0;
const placed = [];
for (const [name, w, h] of [...skel.frames].sort((a, b) => b[2] - a[2])) {
  if (cx + w + PAD > W) { cx = PAD; cy += shelf + PAD; shelf = 0; }
  placed.push({ name, x: cx, y: cy, w, h }); cx += w + PAD; shelf = Math.max(shelf, h);
}
const H = cy + shelf + PAD;
const atlasImg = new Img(W, H);
for (const f of placed) drawFrame(atlasImg, f.x, f.y, f.w, f.h, f.name);
writeFileSync(new URL('atlas-0.png', out), atlasImg.png());
writeFileSync(new URL('atlas.json', out), JSON.stringify({ textures: [{ image: 'atlas-0.png', format: 'RGBA8888', size: { w: W, h: H }, scale: 1,
  frames: placed.map((f) => ({ filename: f.name, rotated: false, trimmed: false, sourceSize: { w: f.w, h: f.h }, spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, frame: { x: f.x, y: f.y, w: f.w, h: f.h } })) }] }));

// ---------------------------------------------------------------- characters: a little figure per frame (16x32)
const SKIN = [[240, 200, 160], [200, 150, 110], [150, 100, 70], [110, 70, 50]];
for (const [id, c] of Object.entries(skel.manifest.chars)) {
  const rows = Object.values(c.rows), nRows = rows.length, img = new Img(c.cols * 16, nRows * 32);
  const hsh = hash(id), body = [60 + (hsh % 160), 60 + ((hsh >> 8) % 160), 60 + ((hsh >> 16) % 160), 255], skin = SKIN[hsh % 4], hair = shade(body, 0.4);
  for (const r of rows) for (let f = 0; f < c.cols; f++) {
    const x = f * 16, y = r.row * 32, step = f % 2, bob = (f % 4 === 1 || f % 4 === 3) ? 1 : 0;
    img.rect(x + 5, y + 9 + bob, 6, 6, skin); img.rect(x + 5, y + 8 + bob, 6, 2, hair);           // head + hair
    img.rect(x + 4, y + 15 + bob, 8, 9, body); img.rect(x + 4, y + 15 + bob, 8, 1, shade(body, 1.3)); // body
    img.rect(x + 5 + (step ? 1 : 0), y + 24, 2, 6, shade(body, 0.5)); img.rect(x + 9 - (step ? 1 : 0), y + 24, 2, 6, shade(body, 0.5)); // legs
  }
  writeFileSync(new URL(`chars/${id}.png`, out), img.png());
}
writeFileSync(new URL('manifest.json', out), JSON.stringify({ ...skel.manifest, placeholder: true }));
console.log(`[art] the licensed art is not in this repository: drew placeholder art (${placed.length} frames, ${Object.keys(skel.manifest.chars).length} characters). The real game: https://casino-and-church.vercel.app`);
