#!/usr/bin/env node
/**
 * Writes apps/client/art-skeleton.json from the real (licensed, git-ignored) art in
 * apps/client/public/assets/vendor-built/: the NAMES and SIZES of every sprite, frame and animation. No pixels.
 * A fresh clone uses it (scripts/ensure-art.mjs) to draw placeholder art, so the game runs without the licensed packs.
 *
 *   node scripts/art-skeleton.mjs      (run where the real art exists, after changing the art)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const base = new URL('../apps/client/public/assets/vendor-built/', import.meta.url);
if (!existsSync(new URL('manifest.json', base))) { console.error('No real art here (vendor-built/manifest.json missing).'); process.exit(1); }
const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
if (manifest.placeholder) { console.error('vendor-built holds placeholder art; run this where the real art is.'); process.exit(1); }
const atlas = JSON.parse(readFileSync(new URL('atlas.json', base), 'utf8'));
const frames = atlas.textures.flatMap((t) => t.frames.map((f) => [f.filename, f.sourceSize.w, f.sourceSize.h]));
writeFileSync(new URL('../apps/client/art-skeleton.json', import.meta.url), JSON.stringify({ note: 'sprite names and sizes only (no art); see scripts/ensure-art.mjs', manifest, frames }));
console.log(`art-skeleton.json: ${frames.length} frames, ${Object.keys(manifest.chars).length} characters, ${Object.keys(manifest.anims).length} animations`);
