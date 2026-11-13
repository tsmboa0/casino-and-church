/** 8x8 pixel icons rendered as crisp inline SVG. */
const PAL: Record<string, string> = {
  o: '#14101c', y: '#f5c542', Y: '#ffe58a', d: '#c98a1e',
  g: '#3fbf6a', G: '#8af0a4', e: '#1f7a45',
  w: '#f4ead5', c: '#f4ead5', s: '#9aa0bf', r: '#e8394a', R: '#ff8a9a', b: '#3a7bd5', B: '#9fd0ff', p: '#ff2e88', n: '#8a5a2b',
};
const ICONS: Record<string, string[]> = {
  coin: ['..oooo..', '.oYYyyo.', 'oYYyydyo', 'oYyydyyo', 'oYyydyyo', 'oyyydddo', '.oyddddo', '..oooo..'],
  clover: ['.oo..oo.', 'oGGooGGo', 'oGggggGo', '.oggggo.', '.oGggGo.', 'oGggeggo', 'oooeoooo', '...ee...'],
  cross: ['...oo...', '..oYYo..', '..oYyo..', 'ooYYyyoo', 'oYYyyyyo', 'ooYyydoo', '..oyydo.', '..oooo..'],
  gear: ['...ww...', '.w.ww.w.', '..wwww..', 'wwwoowww', 'wwwoowww', '..wwww..', '.w.ww.w.', '...ww...'],
  wallet: ['oooooooo', 'obbbbbbo', 'obBBBBbo', 'obbbbowo', 'obbbbbbo', 'obbbbbbo', 'oooooooo', '........'],
  dice: ['.oooooo.', 'owwwwwwo', 'owowwwwo', 'owwwwwwo', 'owwwowwo', 'owwwwwwo', 'owwwwowo', '.oooooo.'],
  slot: ['.oooooo.', 'orrrrrro', 'orwrwrwo', 'orrrrrro', 'oyyyyyyo', 'oyoyoyoo', 'oyyyyyyo', '.oooooo.'],
  heart: ['........', '.oo..oo.', 'orRoorRo', 'orRRRrRo', '.orRRrro', '..orrro.', '...oro..', '....o...'],
  sound: ['...w....', '..ww..s.', 'wwww...s', 'wwww.s.s', 'wwww.s.s', 'wwww...s', '..ww..s.', '...w....'],
  mute: ['...w....', '..ww.r.r', 'wwww..r.', 'wwww.r.r', 'wwww.r.r', 'wwww..r.', '..ww.r.r', '...w....'],
  map: ['oooooooo', 'owsswwso', 'owssrwso', 'owsrwrso', 'owssrwso', 'owsswwso', 'oooooooo', '........'],   // a folded map, X marks the spot
  skip: ['........', 'o..o....', 'oo.oo...', 'ooooo...', 'oo.oo...', 'o..o....', '........', '........'],
};
export function icon(name: string, size = 16, cls = ''): string {
  const rows = ICONS[name] ?? ICONS.coin;
  let rects = '';
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.' && PAL[ch]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${PAL[ch]}"/>`; }));
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
