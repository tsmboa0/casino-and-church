import Phaser from 'phaser';
import { ATLAS_BASE } from '../config';

export class PreloadScene extends Phaser.Scene {
  constructor() { super('Preload'); }
  preload() {
    const { width, height } = this.scale;
    const bar = this.add.graphics();
    const label = this.add.text(width / 2, height / 2 - 14, 'LOADING', { fontFamily: '"Silkscreen", monospace', fontSize: '8px', color: '#f5c542' }).setOrigin(0.5);
    this.load.on('progress', (v: number) => {
      bar.clear();
      bar.fillStyle(0x14101c).fillRect(width / 2 - 52, height / 2 - 2, 104, 8);
      bar.fillStyle(0xf5c542).fillRect(width / 2 - 50, height / 2, Math.floor(100 * v), 4);
    });
    this.load.json('manifest', `${ATLAS_BASE}manifest.json`);
    this.load.multiatlas('atlas', `${ATLAS_BASE}atlas.json`, ATLAS_BASE);
    this.load.once('filecomplete-json-manifest', () => {
      const m = this.cache.json.get('manifest');
      Object.keys(m.chars).forEach(id =>
        this.load.spritesheet(id, `${ATLAS_BASE}chars/${id}.png`, { frameWidth: 16, frameHeight: 32 }));
    });
    void label;
  }
  create() {
    const m = this.cache.json.get('manifest');
    // ----- character animations
    for (const [id, c] of Object.entries<any>(m.chars)) {
      for (const [row, meta] of Object.entries<any>(c.rows)) {
        const start = meta.row * c.cols;
        const walk = row.startsWith('walk');
        this.anims.create({
          key: `${id}:${row}`,
          frames: this.anims.generateFrameNumbers(id, { start, end: start + meta.frames - 1 }),
          frameRate: Math.max(3, Math.min(12, 1000 / meta.ms * (walk ? 1.05 : 1))),
          repeat: row.startsWith('idle') || walk ? -1 : 0,
        });
      }
    }
    // ----- object animations (props, doors, fx)
    for (const [key, a] of Object.entries<any>(m.anims)) {
      const frames = Array.from({ length: a.frames }, (_, i) => ({ key: 'atlas', frame: `a/${key}/${i}` }));
      const isDoor = key.includes('/doors/');
      this.anims.create({ key: `anim:${key}`, frames, frameRate: Math.max(2, 1000 / a.ms), repeat: isDoor ? 0 : -1 });
    }
    // ----- procedural light textures
    const mk = (name: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
      const t = this.textures.createCanvas(name, w, h)!; draw(t.getContext()); t.refresh();
    };
    mk('glow', 128, 128, c => {
      const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    });
    mk('beam', 96, 160, c => {
      // sheared parallelogram with soft vertical + horizontal falloff
      const g = c.createLinearGradient(0, 0, 0, 160);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.6, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath(); c.moveTo(6, 0); c.lineTo(50, 0); c.lineTo(94, 160); c.lineTo(50, 160); c.closePath(); c.fill();
      c.globalCompositeOperation = 'destination-in';
      const h = c.createLinearGradient(0, 0, 96, 0);
      h.addColorStop(0, 'rgba(255,255,255,0)'); h.addColorStop(0.3, 'rgba(255,255,255,1)'); h.addColorStop(0.7, 'rgba(255,255,255,1)'); h.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = h; c.fillRect(0, 0, 96, 160);
    });
    mk('dust', 3, 3, c => { c.fillStyle = '#fff'; c.fillRect(0, 0, 2, 2); c.globalAlpha = 0.5; c.fillRect(2, 0, 1, 3); });
    mk('spark', 5, 5, c => { c.fillStyle = '#fff'; c.fillRect(2, 0, 1, 5); c.fillRect(0, 2, 5, 1); c.fillRect(1, 1, 3, 3); });
    // procedural stone pillar (matches the chapel stone palette)
    mk('pillar_tex', 16, 48, c => {
      const col = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      col(0, 44, 16, 4, '#14101c'); col(1, 41, 14, 4, '#9b8d78'); col(1, 41, 14, 1, '#d6c9b0');   // plinth
      col(3, 10, 10, 31, '#14101c');                                                              // shaft outline
      col(4, 10, 8, 31, '#cdbfa6'); col(4, 10, 2, 31, '#e8ddc6'); col(10, 10, 2, 31, '#a89a84'); col(12, 10, 1, 31, '#7e715f');
      for (let y = 14; y < 40; y += 6) col(4, y, 8, 1, '#a89a84');                                // drum joints
      col(1, 6, 14, 5, '#14101c'); col(2, 7, 12, 3, '#d6c9b0'); col(2, 7, 12, 1, '#f1e8d2');       // capital
      col(0, 2, 16, 5, '#14101c'); col(1, 3, 14, 3, '#b9ab94'); col(1, 3, 14, 1, '#e8ddc6');       // abacus
    });
    // ----- the two big wheels: a stand (static) and a disc (rotated in the scene). Pixel-drawn so they match the art.
    const disc = (name: string, segs: string[], rim: string, rimHi: string) => mk(name, 48, 48, c => {
      const R = 23.5, cx = 24, cy = 24, n = segs.length;
      for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy); if (d > R) continue;
        let f: string;
        if (d > R - 1.2) f = '#14101c';
        else if (d > R - 4) f = (Math.atan2(dy, dx) + Math.PI) % (Math.PI / 6) < 0.18 ? '#fff6c8' : (dy < 0 ? rimHi : rim);
        else if (d < 4.5) f = d < 3 ? '#fff1b0' : '#8a5a14';
        else { const a = (Math.atan2(dy, dx) + Math.PI * 2.5) % (Math.PI * 2); const i = Math.floor((a / (Math.PI * 2)) * n); const edge = ((a / (Math.PI * 2)) * n) % 1; f = edge < 0.06 ? '#fff3cf' : segs[i]; }
        c.fillStyle = f; c.fillRect(x, y, 1, 1);
      }
    });
    disc('fortune_disc', ['#c4202e', '#2f6fd0', '#1f8a4c', '#8a2ac4', '#f08a1a', '#1b1b24', '#d4a017', '#ff2e88'], '#b27a18', '#f5c542');
    disc('harmony_disc', ['#8a2ac4', '#f0b84a', '#b24dff', '#f5c542', '#8a2ac4', '#f0b84a', '#b24dff', '#f5c542', '#8a2ac4', '#f0b84a'], '#a8751f', '#fff1b0');
    const stand = (name: string, body: string, trim: string) => mk(name, 48, 72, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      r(21, 40, 6, 22, '#14101c'); r(22, 40, 4, 22, body); r(22, 40, 1, 22, trim);                  // post
      r(8, 60, 32, 12, '#14101c'); r(9, 61, 30, 10, body); r(9, 61, 30, 2, trim); r(9, 69, 30, 2, '#14101c');   // plinth
      r(20, 0, 8, 8, '#14101c'); r(21, 1, 6, 5, trim);                                               // pointer
      r(22, 6, 4, 3, '#14101c'); r(23, 6, 2, 2, '#e8394a');
    });
    // ----- the Ledger plaque: an open book on a carved board
    mk('ledger_tex', 32, 24, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      r(0, 0, 32, 24, '#14101c'); r(1, 1, 30, 22, '#5a3418'); r(1, 1, 30, 2, '#8a5a2b'); r(2, 3, 28, 1, '#f0b84a');
      r(4, 6, 12, 14, '#efe2c0'); r(16, 6, 12, 14, '#fbf3dc'); r(15, 6, 2, 14, '#b8a070');                 // pages
      for (let i = 0; i < 5; i++) { r(6, 9 + i * 2, 8 - (i % 2) * 2, 1, '#8a7448'); r(18, 9 + i * 2, 8 - ((i + 1) % 2) * 3, 1, '#8a7448'); }
      r(21, 6, 2, 16, '#c4202e'); r(21, 21, 1, 2, '#c4202e');                                              // ribbon
      r(14, 2, 4, 3, '#f5c542');
    });
    // ----- THE CONFESSIONAL: a dark wooden booth, the priest's grille in the middle, a velvet curtain either side
    mk('confess_tex', 48, 48, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      r(0, 6, 48, 42, '#14101c'); r(1, 7, 46, 40, '#4a2a14'); r(1, 7, 46, 3, '#7a4a22'); r(0, 4, 48, 3, '#14101c'); r(1, 5, 46, 2, '#a86a32');  // body + cornice
      r(22, 0, 4, 7, '#14101c'); r(23, 0, 2, 6, '#f0b84a'); r(21, 2, 6, 2, '#f0b84a');                                                       // cross
      for (const x of [3, 31]) { r(x, 12, 14, 33, '#14101c'); r(x + 1, 13, 12, 32, '#6b1530');                                                    // curtained bays
        for (let i = 0; i < 6; i++) r(x + 1 + i * 2, 13, 1, 32, '#8a1f3e'); r(x + 1, 13, 12, 2, '#c9a24a'); }
      r(18, 12, 12, 33, '#14101c'); r(19, 13, 10, 32, '#5a3418'); r(19, 13, 10, 1, '#8a5a2b');                                                     // the priest's door
      r(20, 17, 8, 8, '#14101c'); for (let i = 0; i < 4; i++) { r(21 + i * 2, 18, 1, 6, '#c9a24a'); r(21, 18 + i * 2, 6, 1, '#c9a24a'); }       // grille
      r(26, 31, 2, 2, '#f0b84a');                                                                                                                  // handle
      r(1, 45, 46, 2, '#2a160a');
    });
    // ----- THE WORD AT THE CROSSROADS: a split notice board, neon purple (casino) left, gold parchment (church) right
    mk('board_tex', 64, 48, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      r(6, 30, 4, 18, '#14101c'); r(54, 30, 4, 18, '#14101c'); r(7, 30, 2, 18, '#7a4a22'); r(55, 30, 2, 18, '#7a4a22');       // legs
      r(0, 2, 64, 32, '#14101c'); r(1, 3, 62, 30, '#7a4a22'); r(1, 3, 62, 2, '#a86a32');                                       // frame
      r(3, 7, 28, 24, '#1a0a2e'); r(33, 7, 28, 24, '#efe2c0');                                                                    // two halves
      r(3, 7, 28, 1, '#d58cff'); r(3, 30, 28, 1, '#b24dff'); r(31, 7, 2, 24, '#f5c542');                                         // neon edge, gold seam
      for (let i = 0; i < 4; i++) { r(6, 12 + i * 4, 10 + (i * 7) % 12, 1, i ? '#b48ad8' : '#ffd0e6'); r(36, 12 + i * 4, 12 + (i * 5) % 10, 1, i ? '#8a7448' : '#8a0f20'); }
      r(22, 11, 6, 6, '#ff2e88'); r(23, 12, 4, 4, '#ffd0e6');                                                                   // a neon spade-ish lamp
      r(52, 10, 2, 8, '#8a0f20'); r(50, 12, 6, 2, '#8a0f20');                                                                   // a cross
      r(26, 0, 12, 5, '#14101c'); r(27, 1, 10, 3, '#f5c542');                                                                   // the "VS" plate
      r(0, 34, 64, 2, 'rgba(0,0,0,0.35)');
    });
    // ----- THE BTC EXCHANGE: a giant candlestick ticker wall. Marquee on top (the live price is a DOM label over it),
    //       a BTC coin and a LIVE light, a candle chart with wicks, volume and a moving average, a ticker tape, two legs
    mk('tradewall_tex', 128, 64, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      r(12, 56, 6, 8, '#14101c'); r(110, 56, 6, 8, '#14101c'); r(13, 56, 4, 7, '#2e4552'); r(111, 56, 4, 7, '#2e4552');      // legs
      r(4, 62, 120, 2, 'rgba(0,0,0,0.45)');
      r(0, 0, 128, 57, '#14101c'); r(1, 1, 126, 55, '#071018');                                                                // body
      r(1, 1, 126, 1, '#3dd6ff'); r(1, 55, 126, 1, '#0d5a73'); r(1, 1, 1, 55, '#1b6f8a'); r(126, 1, 1, 55, '#1b6f8a');          // neon frame
      for (const x of [0, 125]) for (let y = 4; y < 54; y += 6) r(x, y, 3, 2, y % 12 === 4 ? '#3dffa0' : '#ff4d6d');           // marquee bulbs
      // marquee: the BTC coin (left), the price (DOM, centre), a LIVE light (right)
      r(4, 3, 120, 10, '#14101c'); r(5, 4, 118, 8, '#02070b'); r(5, 4, 118, 1, '#0d4a5e');
      r(8, 5, 6, 6, '#14101c'); r(9, 5, 4, 6, '#f7931a'); r(8, 6, 6, 4, '#f7931a'); r(10, 6, 1, 4, '#fff3dc'); r(11, 6, 1, 1, '#fff3dc'); r(11, 8, 1, 1, '#fff3dc'); r(11, 9, 1, 1, '#fff3dc');
      r(112, 6, 3, 3, '#ff2e4d'); r(113, 7, 1, 1, '#ffd0d8'); r(116, 7, 5, 1, '#ff8a9a');
      // the chart
      r(4, 15, 120, 31, '#14101c'); r(5, 16, 118, 29, '#02060a');
      for (let y = 19; y < 44; y += 5) r(6, y, 116, 1, '#0a1a22');
      for (let x = 20; x < 122; x += 20) r(x, 17, 1, 27, '#081620');
      // a deterministic walk: an uptrend with pullbacks, ending on a big green candle
      const N = 26; let price = 30; const cs: { o: number; cl: number; hi: number; lo: number }[] = [];
      for (let i = 0; i < N; i++) {
        const drift = Math.sin(i * 0.9) * 2.4 + (i % 5 === 3 ? -3.2 : 2.3) + (i === N - 1 ? 3 : 0);
        const o = price, cl = price + drift, hi = Math.max(o, cl) + 1 + (i * 7) % 3, lo = Math.min(o, cl) - 1 - (i * 5) % 2;
        cs.push({ o, cl, hi, lo }); price = cl;
      }
      const vals = cs.flatMap(k => [k.hi, k.lo]), mn = Math.min(...vals), mx = Math.max(...vals);
      const Y = (v: number) => Math.round(40 - ((v - mn) / (mx - mn)) * 22);                                          // rows 18..40
      cs.forEach((k, i) => {
        const x = 8 + i * 4.5 | 0, up = k.cl >= k.o;
        r(x + 1, Y(k.hi), 1, Y(k.lo) - Y(k.hi) + 1, up ? '#1f8a5a' : '#8a1f33');                                         // wick
        const top = Y(Math.max(k.o, k.cl)), bot = Y(Math.min(k.o, k.cl));
        r(x, top, 3, Math.max(1, bot - top + 1), up ? '#3dffa0' : '#ff4d6d');                                            // body
        r(x, 42 + (up ? 0 : 1), 3, up ? 2 : 1, up ? '#145a3a' : '#5a1424');                                               // volume
      });
      // the moving average (gold) and the last price line (dashed)
      cs.forEach((_, i) => { if (i < 3) return; const ma = (cs[i].cl + cs[i - 1].cl + cs[i - 2].cl + cs[i - 3].cl) / 4; r(8 + i * 4.5 | 0, Y(ma), 4, 1, '#ffd24a'); });
      const ly = Y(cs[N - 1].cl); for (let x = 6; x < 122; x += 4) r(x, ly, 2, 1, 'rgba(61,255,160,0.45)');
      r(118, ly - 1, 5, 3, '#3dffa0');
      // ticker tape
      r(4, 47, 120, 7, '#14101c'); r(5, 48, 118, 5, '#000');
      for (let x = 7, i = 0; x < 118; x += 14, i++) {
        const up = i % 3 !== 1;
        r(x, 49, 6, 1, '#7a8a94'); r(x, 51, 4, 1, '#7a8a94');                                                              // "BTC 73k"
        r(x + 7, up ? 50 : 49, 3, 1, up ? '#3dffa0' : '#ff4d6d'); r(x + 8, up ? 49 : 50, 1, 2, up ? '#3dffa0' : '#ff4d6d');   // up/down arrow
      }
    });
    // ----- the BULL and the BEAR, on lit pedestals either side of the exchange
    const statue = (key: string, bull: boolean) => mk(key, 24, 24, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      const K = '#14101c', G = bull ? '#d9a03a' : '#b8323f', D = bull ? '#8a5a14' : '#6b1424', H = bull ? '#ffe08a' : '#ff8a9a';
      r(2, 18, 20, 6, K); r(3, 18, 18, 5, '#2a2236'); r(3, 18, 18, 1, '#4a3a68'); r(8, 21, 8, 1, bull ? '#3dffa0' : '#ff4d6d');   // pedestal + plaque
      if (bull) {
        r(3, 8, 13, 8, K); r(4, 9, 11, 6, G); r(4, 13, 11, 2, D); r(5, 9, 6, 1, H);                                       // body
        r(14, 6, 7, 8, K); r(15, 7, 5, 6, G); r(18, 11, 3, 2, D); r(20, 11, 1, 1, K); r(17, 8, 1, 1, K);                 // head down, charging
        r(14, 3, 1, 4, '#fff1c8'); r(13, 3, 2, 1, '#fff1c8'); r(20, 3, 1, 4, '#fff1c8'); r(20, 3, 2, 1, '#fff1c8');          // horns
        [4, 7, 11, 14].forEach(x => { r(x, 15, 2, 3, K); r(x, 15, 1, 3, D); });                                            // legs
        r(2, 8, 1, 4, K); r(1, 11, 2, 1, K);                                                                               // tail
      } else {
        r(4, 7, 16, 9, K); r(5, 8, 14, 7, G); r(5, 13, 14, 2, D); r(9, 8, 6, 1, H);                                       // body (big, hunched)
        r(0, 6, 8, 8, K); r(1, 7, 6, 6, G); r(1, 5, 2, 2, K); r(6, 5, 2, 2, K); r(1, 10, 2, 2, '#e8a0a8'); r(0, 11, 1, 1, K); r(3, 8, 1, 1, K);   // head, ears, snout, eye
        [5, 8, 14, 17].forEach(x => { r(x, 15, 2, 3, K); r(x, 15, 1, 3, D); });                                            // legs (paws)
        r(5, 17, 1, 1, '#fff'); r(17, 17, 1, 1, '#fff');                                                                   // claws
      }
    });
    statue('bull_tex', true); statue('bear_tex', false);
    // ----- THE COMMISSION DESK: a heavy desk, an open ledger, quill and ink, a red wax seal, a candle, a brass plate
    mk('commission_tex', 48, 40, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      r(1, 18, 46, 22, '#14101c'); r(2, 18, 44, 20, '#6b3a1a'); r(2, 18, 44, 3, '#a86a32'); r(2, 21, 44, 1, '#3a1f0e');   // desk top + front
      r(4, 24, 18, 11, '#4a2810'); r(26, 24, 18, 11, '#4a2810'); r(12, 28, 2, 2, '#f0b84a'); r(34, 28, 2, 2, '#f0b84a');  // drawers
      r(18, 34, 12, 4, '#14101c'); r(19, 34, 10, 3, '#c9a24a'); r(20, 35, 8, 1, '#7a5a1a');                                 // brass plate
      r(3, 38, 4, 2, '#2a160a'); r(41, 38, 4, 2, '#2a160a');                                                                // feet
      // the open ledger on the desk
      r(8, 8, 26, 12, '#14101c'); r(9, 9, 12, 10, '#efe2c0'); r(21, 9, 12, 10, '#fbf3dc'); r(20, 9, 2, 10, '#b8a070');
      for (let i = 0; i < 4; i++) { r(11, 11 + i * 2, 8 - (i % 2) * 2, 1, '#8a7448'); r(23, 11 + i * 2, 7 - ((i + 1) % 2) * 2, 1, '#8a7448'); }
      r(27, 15, 4, 4, '#c4202e'); r(28, 16, 2, 2, '#8a0f20');                                                                // wax seal
      // ink pot and quill
      r(5, 12, 4, 5, '#14101c'); r(6, 13, 2, 3, '#2a2a4a'); r(7, 2, 1, 11, '#fff3dc'); r(6, 3, 1, 6, '#e8dcc0'); r(8, 4, 1, 4, '#e8dcc0');
      // the candle
      r(39, 9, 4, 10, '#14101c'); r(40, 10, 2, 9, '#f4ead5'); r(40, 6, 2, 4, '#ffb347'); r(40, 7, 2, 2, '#fff3b0'); r(37, 18, 8, 2, '#c9a24a');
    });
    // ----- a full-size craps table (the pack's one is far smaller than the other tables)
    mk('craps_tex', 128, 64, c => {
      const r = (x: number, y: number, w: number, h: number, f: string) => { c.fillStyle = f; c.fillRect(x, y, w, h); };
      const round = (x: number, y: number, w: number, h: number, rad: number, f: string) => {
        c.fillStyle = f;
        for (let j = 0; j < h; j++) { const dy = Math.min(j, h - 1 - j); const inset = dy < rad ? Math.round(rad - Math.sqrt(rad * rad - (rad - dy) * (rad - dy))) : 0; c.fillRect(x + inset, y + j, w - inset * 2, 1); }
      };
      round(0, 4, 128, 60, 14, '#14101c');                    // outline
      round(1, 5, 126, 52, 13, '#7a4a22');                    // wooden rail (top face)
      round(1, 44, 126, 19, 10, '#4a2a10');                   // rail front face
      round(3, 7, 122, 47, 11, '#a86a32'); round(4, 8, 120, 45, 10, '#7a4a22');
      round(8, 11, 112, 38, 8, '#0f5a37');                    // felt shadow edge
      round(9, 12, 110, 36, 7, '#1f8a4c');                    // felt
      for (let i = 0; i < 26; i++) r(12 + ((i * 37) % 104), 14 + ((i * 17) % 32), 1, 1, '#2a9a5a');   // felt texture
      c.strokeStyle = '#f4ead5'; c.lineWidth = 1;
      const line = (x: number, y: number, w: number, h: number) => { r(x, y, w, 1, '#f4ead5'); r(x, y + h - 1, w, 1, '#f4ead5'); r(x, y, 1, h, '#f4ead5'); r(x + w - 1, y, 1, h, '#f4ead5'); };
      line(15, 16, 98, 28);                                   // pass line
      line(22, 21, 84, 18);                                   // come
      r(22, 30, 84, 1, '#f4ead5');                            // field split
      r(26, 24, 16, 3, '#c4202e'); r(86, 24, 16, 3, '#c4202e'); // the "7" boxes
      r(50, 33, 28, 4, '#f5c542');                            // the FIELD bar
      const die = (x: number, y: number, pips: number[][]) => { r(x, y, 7, 7, '#14101c'); r(x + 1, y + 1, 5, 5, '#fffaf0'); pips.forEach(([px, py]) => r(x + 1 + px, y + 1 + py, 1, 1, '#c4202e')); };
      die(56, 21, [[0, 0], [2, 2], [4, 4]]); die(65, 23, [[0, 0], [4, 0], [0, 4], [4, 4]]);
      [[18, 46, '#c4202e'], [24, 47, '#2f6fd0'], [100, 46, '#1f8a4c'], [106, 47, '#1b1b24']].forEach(([x, y, f]) => { r(x as number, y as number, 5, 3, '#14101c'); r((x as number) + 1, (y as number), 3, 2, f as string); });
    });
    stand('fortune_stand', '#5a1030', '#f5c542');
    stand('harmony_stand', '#3a2a5a', '#fff1b0');
    this.scene.start('World');
  }
}
