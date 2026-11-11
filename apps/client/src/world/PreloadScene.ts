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
