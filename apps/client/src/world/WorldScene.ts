import Phaser from 'phaser';
import { CHAR_SCALE, WORLD_W, WORLD_H, CASINO_WALL_X, CHURCH_WALL_X, DOOR_Y0, DOOR_Y1, COLORS, type Realm, type Zone, type Facing } from '../config';
import { buildWorld, type World, type Interactable, type Rect } from './layout';
import { CollisionGrid } from './collision';
import { Player, Npc, Bubble, Marker, type Character } from './entities';
import { findPath } from './pathfind';
import { runTour, CASINO_STOPS, CHURCH_STOPS } from './tour';
import { input } from '../core/input';
import { store, loadPos, savePos, type Profile } from '../core/state';
import { bus, type PanelKind } from '../core/bus';
import { overlay } from '../ui/overlay';
import { audio } from '../core/audio';
import { backend, type AgentDecision } from '../core/backend';
import { TABLE } from '../core/rules';

const NPC_LINES: Record<string, string[]> = {
  owner: [
    'The house always smiles. Sometimes it even means it.',
    'Every bet is dealt by my wallet. Check the chain, I have nothing to hide.',
    'Winning builds your LUCK. Spend it wisely.',
    'Too long in here and your FAITH fades. Go visit the Church.',
  ],
  priest: [
    'Faith is a muscle, wanderer. Exercise it.',
    'The tithe feeds the blessings. The blessings feed the faithful.',
    'LUCK offered at the altar becomes FAITH. A fair trade.',
    'Do not fear the Casino. Fear forgetting the Church.',
  ],
  patron: ['...', 'Nice night for it.', 'I almost had it.', 'Have you tried the coin flip?'],
};

const GAP = 16;                                   // thickness of the realm walls (the doorway zone)
const HOST: Record<Realm, string> = { casino: 'Don Fortuna', church: 'Father Nakamoto' };

export class WorldScene extends Phaser.Scene {
  world!: World;
  grid!: CollisionGrid;
  player?: Player;
  npcs = new Map<string, Npc>();
  bubble!: Bubble;
  private marker!: Marker;
  private manifest: any;
  private doorSprites: { s: Phaser.GameObjects.Sprite; key: string; open: boolean; trig: Rect }[] = [];
  private promptEl!: HTMLElement;
  private signEls: { el: HTMLElement; x: number; y: number; anchor: string; kind: string; plot?: number }[] = [];
  private plotObjs = new Map<number, Phaser.GameObjects.GameObject[]>();
  /** the AI hosts' latest words (they say these first when you talk to them) */
  private hostLine: Record<'fortuna' | 'nakamoto', string> = { fortuna: '', nakamoto: '' };
  private toldLine = new Set<string>();
  private tagged: Character[] = [];
  private current?: Interactable;
  private tourCancel = false;
  private touring = false;
  private playing = false;
  private insetTop = 0;                  // CSS px reserved for the HUD bar
  private camX = 0; private camY = 0;    // world point at the centre of the viewport
  private pending: Record<Realm, boolean> = { casino: false, church: false };
  /** where the player is: a realm, or the plaza between them */
  private stable: Zone = 'plaza';
  private gateAsk: Realm | null = null;
  private gateLeave = false;                 // the open prompt is a LEAVE (not an ENTER) question
  private gatePass: Zone | null = null;
  private dialogueTimer?: Phaser.Time.TimerEvent;
  private talkingTo?: Npc;
  /** "come round the front" hint when the player stands beside or behind a table/machine */
  private hint!: Bubble;
  private sideOf?: Interactable;
  private sideSince = 0;
  private sideTold = new Map<string, number>();
  private hintSeq = 0;

  constructor() { super('World'); }

  create() {
    this.manifest = this.cache.json.get('manifest');
    this.world = buildWorld(this.manifest.props);
    this.grid = new CollisionGrid(this.world.colliders, WORLD_W, WORLD_H);
    this.cameras.main.setBackgroundColor(COLORS.ink);
    this.cameras.main.roundPixels = true;
    this.camX = this.world.plazaCenter.x; this.camY = this.world.plazaCenter.y;

    this.bakeGround();
    this.spawnProps();
    this.spawnSigns();
    this.spawnDoors();
    this.spawnNpcs();
    this.spawnLighting();
    this.promptEl = overlay.make('prompt');
    this.promptEl.setAttribute('role', 'button');
    this.promptEl.style.display = 'none';
    this.promptEl.style.pointerEvents = 'auto';
    this.promptEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); if (this.current && !this.touring && this.playing) this.interact(this.current); });
    bus.on('plotsChanged', () => this.syncPlots());
    bus.on('agentDecision', (d: AgentDecision) => {
      this.hostLine[d.agent] = d.line;
      const who = d.agent === 'fortuna' ? 'DON FORTUNA' : 'FATHER NAKAMOTO';
      const t = this.signEls.find(s => s.kind === 'ticker'); if (t) { t.el.textContent = `${who}: ${d.line}`; t.el.classList.remove('flash'); void t.el.offsetWidth; t.el.classList.add('flash'); }
      if (d.action !== 'none' && this.playing) bus.emit('toast', `${who}: ${d.line.length > 70 ? d.line.slice(0, 68) + '...' : d.line}`);
    });
    this.syncPlots();
    this.watchBtc();
    bus.on('worldTap', (cx: number, cy: number) => this.onTap(cx, cy));
    bus.on('travel', (id: string) => { this.travelTo(id); });
    this.bubble = new Bubble(this);
    this.hint = new Bubble(this);
    this.marker = new Marker();

    if (this.game.renderer.type === Phaser.WEBGL) {
      try { this.cameras.main.postFX.addVignette(0.5, 0.5, 0.97, 0.26); } catch { /* optional */ }
    }
    this.applyView(true);
    this.scale.on('resize', () => this.applyView(true));
    (window as any).__world = this;
  }

  // ------------------------------------------------------------------ camera
  /** CSS px at the top of the screen that the DOM HUD occupies. The world fills everything below it. */
  setInsetTop(px: number) { this.insetTop = px; this.applyView(true); }

  private metrics() {
    const W = this.scale.width, H = this.scale.height;
    const dpr = W / (this.game.canvas.getBoundingClientRect().width || window.innerWidth);
    const top = Math.round(this.insetTop * dpr);
    const vh = H - top;
    // ~1.6 CSS px per art pixel on phones, up to 2.4 on big windows; always a whole number of device px per art px
    const scaleCss = Math.max(1.3, Math.min(2.2, vh / dpr / 254));
    const z = Math.max(2, Math.round(scaleCss * dpr));
    return { W, H, dpr, top, vh, z };
  }
  private applyView(snap = false) {
    const m = this.metrics();
    const cam = this.cameras.main;
    cam.setViewport(0, m.top, m.W, m.vh);
    cam.setZoom(m.z);
    overlay.fit = { z: m.z, vpX: 0, vpY: m.top, vpW: m.W, vpH: m.vh, dpr: m.dpr, cx: this.camX, cy: this.camY };
    this.followCam(0, snap);
  }
  /** Deterministic follow: runs inside update() so DOM labels use exactly the same camera as the canvas. */
  private followCam(dt: number, snap = false) {
    const m = this.metrics();
    const target = this.playing && this.player ? { x: this.player.x, y: this.player.y - 10 } : this.world.plazaCenter;
    const vw = m.W / m.z, vh = m.vh / m.z;
    const tx = WORLD_W <= vw ? WORLD_W / 2 : Phaser.Math.Clamp(target.x, vw / 2, WORLD_W - vw / 2);
    const ty = WORLD_H <= vh ? WORLD_H / 2 : Phaser.Math.Clamp(target.y, vh / 2, WORLD_H - vh / 2);
    const k = snap ? 1 : 1 - Math.pow(0.002, dt / 1000);
    this.camX += (tx - this.camX) * k; this.camY += (ty - this.camY) * k;
    const sx = Math.round(this.camX * m.z) / m.z, sy = Math.round(this.camY * m.z) / m.z;   // pixel-aligned
    const cam = this.cameras.main;
    cam.setScroll(sx - m.W / 2, sy - m.vh / 2);
    overlay.fit.cx = sx; overlay.fit.cy = sy;
  }

  // ------------------------------------------------------------------ build
  private bakeGround() {
    const tex = this.textures.createCanvas('ground', WORLD_W, WORLD_H)!;
    const ctx = tex.getContext();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#14101c'; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    const atlas = this.textures.get('atlas');
    for (const op of this.world.ops) {
      if (op.t === 'rect') { ctx.fillStyle = op.color; ctx.fillRect(op.x, op.y, op.w, op.h); continue; }
      const f = atlas.get(op.name);
      if (!f || f.name === '__BASE') { console.warn('missing frame', op.name); continue; }
      ctx.drawImage(f.source.image as CanvasImageSource, f.cutX, f.cutY, f.cutWidth, f.cutHeight, op.x, op.y, f.cutWidth, f.cutHeight);
    }
    const shade = (x: number, y: number, w: number, h: number, a: number) => {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, `rgba(10,6,20,${a})`); g.addColorStop(1, 'rgba(10,6,20,0)');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    };
    shade(0, 32, WORLD_W, 12, 0.4);
    // wall caps: the top of a wall seen from above, in the realm's material, with a soft contact shadow on the floor
    const CAP = { casino: ['#1a0f22', '#4a2a5e', '#d9b45a'], church: ['#2a2118', '#cfc3a4', '#f1e8d2'], plaza: ['#1e1a28', '#8f8672', '#c9bfa8'] } as const;
    for (const b of this.world.bars) {
      const [edge, body, hi] = CAP[b.style ?? 'casino'];
      if (b.h > b.w) { ctx.fillStyle = 'rgba(10,6,20,0.35)'; ctx.fillRect(b.x + b.w + 1, b.y + 4, 5, b.h - 4); }
      ctx.fillStyle = edge; ctx.fillRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
      ctx.fillStyle = body; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = hi; if (b.h > b.w) ctx.fillRect(b.x, b.y, 1, b.h); else ctx.fillRect(b.x, b.y, b.w, 1);
    }
    ctx.fillStyle = '#0d0a14'; ctx.fillRect(0, 646, WORLD_W, WORLD_H - 646);
    tex.refresh();
    this.add.image(0, 0, 'ground').setOrigin(0).setDepth(-10);
  }

  private spawnProps() {
    const anims = this.manifest.anims as Record<string, { frames: number }>;
    for (const p of this.world.props) {
      if (p.alpha === 0) continue;
      if (p.key === 'x/pillar') { this.add.image(p.x, p.y, 'pillar_tex').setOrigin(0, 1).setDepth(p.y); continue; }
      if (p.key === 'x/ledger') { this.add.image(p.x, p.y, 'ledger_tex').setOrigin(0, 1).setDepth(p.y); continue; }
      if (p.key === 'x/confess') { this.add.image(p.x, p.y, 'confess_tex').setOrigin(0, 1).setDepth(p.y); continue; }
      if (p.key === 'x/craps') { this.add.image(p.x, p.y, 'craps_tex').setOrigin(0, 1).setDepth(p.y); continue; }
      if (p.key === 'x/board') { this.add.image(p.x, p.y, 'board_tex').setOrigin(0, 1).setDepth(p.y); this.addGlow(p.x + 32, p.y - 30, 40, 0xd58cff, 0.18, 0.05); continue; }
      if (p.key === 'x/tradewall') {
        this.add.image(p.x, p.y, 'tradewall_tex').setOrigin(0, 1).setDepth(p.y);
        this.addGlow(p.x + 64, p.y - 34, 70, 0x3dd6ff, 0.2, 0.04);
        this.addGlow(p.x + 119, p.y - 40, 10, 0x3dffa0, 0.6, 0.35);          // the newest candle, breathing
        this.addGlow(p.x + 113, p.y - 56, 6, 0xff2e4d, 0.7, 0.45);           // LIVE
        continue;
      }
      if (p.key === 'x/commission') {
        this.add.image(p.x, p.y, 'commission_tex').setOrigin(0, 1).setDepth(p.y);
        this.addGlow(p.x + 41, p.y - 30, 14, 0xffb347, 0.55, 0.3);              // the candle
        continue;
      }
      if (p.key === 'x/bull' || p.key === 'x/bear') {
        this.add.image(p.x, p.y, p.key === 'x/bull' ? 'bull_tex' : 'bear_tex').setOrigin(0, 1).setDepth(p.y);
        this.addGlow(p.x + 12, p.y - 12, 18, p.key === 'x/bull' ? 0x3dffa0 : 0xff4d6d, 0.32, 0.08);
        continue;
      }
      if (p.key === 'x/fortune' || p.key === 'x/harmony') {
        // a big wheel: static stand + a disc that turns slowly (and a glow behind it)
        const k = p.key === 'x/fortune' ? 'fortune' : 'harmony';
        this.add.image(p.x, p.y, `${k}_stand`).setOrigin(0, 1).setDepth(p.y);
        const d = this.add.image(p.x + 24, p.y - 72 + 33, `${k}_disc`).setDepth(p.y + 1);
        this.tweens.add({ targets: d, angle: 360, duration: k === 'fortune' ? 26000 : 38000, repeat: -1 });
        this.addGlow(p.x + 24, p.y - 40, 44, k === 'fortune' ? 0xff5aa0 : 0xffe08a, 0.28, 0.05);
        continue;
      }
      const animated = p.anim && anims[p.key];
      if (!this.textures.getFrame('atlas', animated ? `a/${p.key}/0` : p.key)) { console.warn('missing prop frame:', p.key); continue; }
      const s = this.add.sprite(p.x, p.y, 'atlas', animated ? `a/${p.key}/0` : p.key).setOrigin(0, 1);
      if (animated) s.play({ key: `anim:${p.key}`, startFrame: Math.floor(Math.random() * anims[p.key].frames) });
      s.setDepth(p.high ? 5000 + p.y : p.y);
      if (p.flip) s.setFlipX(true);
      if (p.scale) s.setScale(p.scale);
      if (p.tint) s.setTint(p.tint);
      if (p.glow) {
        const g = p.glow, w = s.width, h = s.height;
        this.addGlow(p.x + (g.dx ?? w / 2), p.y + (g.dy ?? -h / 2), g.r, g.color, g.a, g.flicker ?? 0);
      }
    }
  }

  private spawnSigns() {
    for (const s of this.world.signs) {
      const el = overlay.make(`sign ${s.kind}`, s.kind === 'gateC' || s.kind === 'gateH' ? '' : s.text);
      // toll-gate: two pillars across the doorway joined by a beam that carries the name
      if (s.kind === 'gateC' || s.kind === 'gateH') { el.innerHTML = `<i class="gp t"></i><b class="gb"><span></span></b><i class="gp d"></i>`; (el.querySelector('span') as HTMLElement).textContent = s.text; }
      if (s.kind === 'tag' && s.text === 'BTC EXCHANGE') el.classList.add('exch');
      if (s.kind === 'tag' && s.text === 'COMMISSION DESK') el.classList.add('comm');  // lit like a church notice      // the exchange's name plate is neon, not brass
      this.signEls.push({ el, x: s.x, y: s.y, anchor: s.anchor ?? '-50%, 0', kind: s.kind, plot: s.plot });
    }
  }

  /**
   * The BTC Exchange's marquee: the live price, green or red against the running round's lock price. Every 4 s while
   * the exchange is on screen, every 20 s otherwise; the server answers from one shared
   * snapshot, so this costs no chain reads.
   */
  private watchBtc() {
    const sign = this.signEls.find(s => s.kind === 'btc'); if (!sign || !backend.market) return;
    sign.el.innerHTML = '<small>BTC</small><b>…</b>';
    const tick = async () => {
      if (!document.hidden) {
        try {
          const m = await backend.market!();
          const p = m.price ?? m.oraclePrice, lock = m.live && m.live.bets > 0 ? m.live.lockPrice : null;   // only a round with bets in it
          const dir = p != null && lock != null ? (p > lock ? 'up' : p < lock ? 'down' : '') : '';
          sign.el.className = `sign btc ${dir}`;
          sign.el.innerHTML = p == null ? '<small>BTC</small><b>…</b>'
            : `<small>BTC</small><b>$${Math.round(p).toLocaleString('en-US')}</b>${dir ? `<i>${dir === 'up' ? '&#9650;' : '&#9660;'}</i>` : ''}`;
        } catch { /* the kiosk keeps its last price */ }
      }
      const near = !!this.player && Math.hypot(this.player.x - sign.x, this.player.y - sign.y) < 320;   // the exchange is on screen
      this.time.delayedCall(near ? 4_000 : 20_000, () => void tick());
    };
    void tick();
  }

  /** owned plots show the player's machine (two slot cabinets in the chosen colour) and the machine's name on the sign */
  private syncPlots() {
    for (const spot of this.world.plots) {
      const p = store.plots[spot.id]; const sign = this.signEls.find(s => s.plot === spot.id);
      if (sign) { sign.el.textContent = p ? p.name.toUpperCase() : `FOR SALE #${spot.id}`; sign.el.classList.toggle('owned', !!p); }
      const want = p ? `own:${p.skin}` : 'ghost';
      const have = this.plotObjs.get(spot.id);
      if (have && (have as any).state === want) continue;
      have?.forEach(o => o.destroy());
      // unowned: a flickering hologram of the machine you could own; owned: the real cabinets in your colour
      const key = `c/slots/slot_${p ? p.skin : 'gold'}`; if (!this.textures.getFrame('atlas', key)) continue;
      const objs: Phaser.GameObjects.GameObject[] = [];
      [-18, 2].forEach(dx => {
        const s = this.add.sprite(spot.x + dx, spot.y, 'atlas', key).setOrigin(0, 1).setDepth(spot.y);
        if (!p) { s.setTint(0x7dffd0).setAlpha(0.32).setBlendMode(Phaser.BlendModes.ADD); this.tweens.add({ targets: s, alpha: { from: 0.18, to: 0.42 }, duration: 900 + dx * 10, yoyo: true, repeat: -1 }); }
        objs.push(s);
      });
      objs.push(this.add.image(spot.x, spot.y - 16, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(6000).setTint(p ? 0xffd24a : 0x7dffd0).setAlpha(p ? 0.35 : 0.18));
      (objs as any).state = want;
      this.plotObjs.set(spot.id, objs);
    }
  }

  private spawnDoors() {
    for (const d of this.world.doors) {
      const s = this.add.sprite(d.x, d.y, 'atlas', `a/${d.key}_open/0`).setOrigin(0, 1).setDepth(d.y - 20);
      this.doorSprites.push({ s, key: d.key, open: false, trig: d.trigger });
    }
  }

  private spawnNpcs() {
    for (const n of this.world.npcs) {
      const npc = new Npc(this, n.char, n.x, n.y, n.role);
      npc.look(n.facing, false);
      if (n.role !== 'patron') { npc.tag(n.name, n.role); this.tagged.push(npc); }
      npc.anims.setProgress(Math.random());
      this.npcs.set(n.id, npc);
    }
  }

  private addGlow(x: number, y: number, r: number, color: number, a: number, flicker: number) {
    const g = this.add.image(x, y, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(6000).setTint(color).setAlpha(a);
    g.setScale((r * 2) / 128);
    if (flicker > 0) {
      this.tweens.add({
        targets: g, alpha: { from: a * (1 - flicker * 2), to: a }, scale: { from: g.scale * (1 - flicker), to: g.scale },
        duration: 160 + Math.random() * 260, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: Math.random() * 500,
      });
    }
    return g;
  }

  private spawnLighting() {
    for (const l of this.world.lights) this.addGlow(l.x, l.y, l.r, l.color, l.a, l.flicker ?? 0);
    const grade = (x: number, w: number, color: number) =>
      this.add.rectangle(x, 0, w, WORLD_H, color).setOrigin(0).setDepth(5900).setBlendMode(Phaser.BlendModes.MULTIPLY);
    grade(0, CASINO_WALL_X + GAP, 0xb9a6d8);                                   // casino: dark and cool, so the neon and lamps pop
    grade(CASINO_WALL_X + GAP, CHURCH_WALL_X - CASINO_WALL_X - GAP, 0xd8d2e6);   // crossroads: dusk
    this.add.rectangle(CASINO_WALL_X + GAP, 12 * 16, CHURCH_WALL_X - CASINO_WALL_X - GAP, WORLD_H - 12 * 16, 0x8a84a0).setOrigin(0).setDepth(5901).setBlendMode(Phaser.BlendModes.MULTIPLY); // the garden behind the barrier recedes
    grade(CHURCH_WALL_X, WORLD_W - CHURCH_WALL_X, 0xeed6b4);                    // church: warm candlelight
    for (const s of this.world.shafts) {
      const b = this.add.image(s.x, s.y, 'beam').setOrigin(0.3, 0).setDepth(6001).setBlendMode(Phaser.BlendModes.ADD).setTint(s.color).setAlpha(s.a);
      b.setDisplaySize(s.w * 1.6, s.h);
      this.tweens.add({ targets: b, alpha: { from: s.a * 0.55, to: s.a * 1.25 }, duration: 3200 + Math.random() * 2600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: Math.random() * 2000 });
    }
    this.add.particles(0, 0, 'dust', {
      emitZone: { type: 'random', source: new Phaser.Geom.Rectangle(56 * 16, 36, 19 * 16, 300), quantity: 1 } as any,
      lifespan: { min: 5000, max: 9000 }, speedX: { min: -3, max: 3 }, speedY: { min: 1, max: 5 },
      alpha: { start: 0, end: 0, ease: (t: number) => Math.sin(t * Math.PI) * 0.55 }, scale: { min: 0.6, max: 1.1 },
      frequency: 220, blendMode: 'ADD', tint: 0xffe9b0,
    } as any).setDepth(6002);
    this.add.particles(0, 0, 'spark', {
      emitZone: { type: 'random', source: new Phaser.Geom.Rectangle(9 * 16, 36, 21 * 16, 70), quantity: 1 } as any,
      lifespan: 900, scale: { start: 0.8, end: 0 }, alpha: { start: 0.9, end: 0 }, frequency: 320, blendMode: 'ADD', tint: [0xffe08a, 0xff8ac0, 0x9fe8ff],
    } as any).setDepth(6002);
    this.add.particles(0, 0, 'spark', {
      emitZone: { type: 'random', source: new Phaser.Geom.Rectangle(40.5 * 16, 40, 5 * 16, 100), quantity: 1 } as any,
      lifespan: 1400, scale: { start: 0.6, end: 0 }, alpha: { start: 0.7, end: 0 }, frequency: 500, blendMode: 'ADD', tint: [0xffffff, 0xbfe6ff],
    } as any).setDepth(6002);
  }

  // ------------------------------------------------------------------ modes
  /** Called when onboarding finishes. The host of your chosen realm meets you at its entrance. */
  beginPlay(profile: Profile) {
    // CONTINUE: back on the exact spot you left (if it is still a valid floor tile); otherwise the Crossroads
    const saved = loadPos(profile.username);
    const zoneAt = (x: number): Zone | null => x < CASINO_WALL_X ? 'casino' : x >= CHURCH_WALL_X + GAP ? 'church' : (x >= CASINO_WALL_X + GAP && x < CHURCH_WALL_X ? 'plaza' : null);
    const ok = saved && saved.x > 8 && saved.x < WORLD_W - 8 && saved.y > 8 && saved.y < WORLD_H - 8 && zoneAt(saved.x) && !this.grid.feetBlocked(saved.x, saved.y);
    const sp = ok ? { x: saved!.x, y: saved!.y } : this.world.plazaCenter;
    const zone: Zone = ok ? zoneAt(sp.x)! : 'plaza';
    this.player?.destroy();
    this.player = new Player(this, profile.avatar, sp.x, sp.y, this.grid).tag(profile.username, 'player');
    this.tagged.push(this.player);
    this.player.look('down', false);
    this.playing = true;
    this.stable = zone; this.gatePass = null; this.gateAsk = null;
    store.setRealm(zone);
    this.camX = sp.x; this.camY = sp.y - 10; this.followCam(0, true);
    this.cameras.main.fadeIn(600, 20, 16, 28);
    this.pending = { casino: !profile.toursDone.casino, church: !profile.toursDone.church };
    bus.emit('realm', zone, true);
    if (zone !== 'plaza') {
      void backend.enterRealm(zone).catch(() => { /* presence is best-effort */ });
      if (this.pending[zone]) this.time.delayedCall(1200, () => this.startTour(zone));
      this.time.delayedCall(900, () => bus.emit('toast', `Welcome back. You are in the ${zone === 'casino' ? 'Casino' : 'Church'}, right where you left.`));
    } else {
      this.time.delayedCall(900, () => bus.emit('toast', ok ? 'Welcome back to the Crossroads.' : 'Pick a road: the Casino is left, the Church is right.'));
    }
    // remember the spot: every second while moving, and when the page goes away
    const name = profile.username;
    let lx = -1, ly = -1;
    const keep = () => { const p = this.player; if (!p || !this.playing || this.gateAsk) return; if (Math.abs(p.x - lx) < 2 && Math.abs(p.y - ly) < 2) return; lx = p.x; ly = p.y; savePos({ name, x: Math.round(p.x), y: Math.round(p.y), at: Date.now() }); };
    this.posTimer?.remove(); this.posTimer = this.time.addEvent({ delay: 1000, loop: true, callback: keep });
    window.addEventListener('pagehide', keep); document.addEventListener('visibilitychange', () => { if (document.hidden) keep(); });
  }
  private posTimer?: Phaser.Time.TimerEvent;

  private async startTour(realm: Realm) {
    if (this.touring || !this.player || this.stable !== realm) return;
    this.touring = true; this.tourCancel = false;
    this.pending[realm] = false;
    const guide = this.npcs.get(realm === 'casino' ? 'owner' : 'priest')!;
    guide.stopWalking(); guide.busy = true;
    bus.emit('tour', realm, true);
    // the host has seen you come in: he leaves his office / sanctum and comes to wherever you are
    const met = await this.comeToPlayer(guide, realm);
    const ok = met && await runTour({
      scene: this, guide, player: this.player, bubble: this.bubble, marker: this.marker, grid: this.grid, realm,
      route: this.world.routes[realm], stops: realm === 'casino' ? CASINO_STOPS : CHURCH_STOPS,
      name: store.profile?.username ?? 'wanderer', hostName: HOST[realm],
      isCancelled: () => this.tourCancel || this.stable !== realm,
      onStop: (i, n) => bus.emit('tourStep', i, n),
    });
    const homePath = findPath(this.grid, { x: guide.x, y: guide.y }, guide.home, WORLD_W, WORLD_H);
    guide.walk(homePath, 64).then(() => guide.look('down', false));
    this.touring = false;
    bus.emit('tour', realm, false);
    if (ok && store.profile) store.setProfile({ ...store.profile, toursDone: { ...store.profile.toursDone, [realm]: true } });
    if (ok) void backend.completeTour?.(realm).catch(() => {});
    if (ok) bus.emit('toast', realm === 'casino' ? 'Tour complete. Welcome to the house.' : 'Tour complete. Peace be with you.');
    else this.pending[realm] = false;
  }
  /** The host walks over to the player (re-aiming as they move), calls out on the way, then turns to greet them. */
  private async comeToPlayer(guide: Npc, realm: Realm): Promise<boolean> {
    const p = this.player!, name = store.profile?.username ?? 'wanderer';
    const cancelled = () => this.tourCancel || this.stable !== realm || !this.player;
    const call = realm === 'casino' ? `A new face! Stay right there, ${name}. I'm coming over.` : `Welcome, ${name}! Rest a moment, child. I am coming to you.`;
    guide.anims.timeScale = 1.15;
    let aim = { x: -1e9, y: 0 };
    await new Promise<void>((res) => {
      let last = 0, called = false;
      const step = (t: number) => {
        if (cancelled()) { this.events.off('update', step); return res(); }
        // he calls out the moment he walks into view (not while he is still off-screen)
        if (!called) {
          const v = this.cameras.main.worldView;
          if (guide.x > v.x + 6 && guide.x < v.right - 6 && guide.y - 30 > v.y && guide.y < v.bottom - 4) { called = true; this.bubble.show(guide, HOST[realm], call); }
        }
        const d = Math.hypot(p.x - guide.x, p.y - guide.y);
        if (d < 30) { this.events.off('update', step); return res(); }
        // re-plan towards the player whenever they have moved (at most ~3 times a second)
        if (t - last > 300 && Math.hypot(p.x - aim.x, p.y - aim.y) > 12) {
          last = t; aim = { x: p.x, y: p.y };
          const goal = { x: p.x + (guide.x < p.x ? -18 : 18), y: p.y + 2 };
          const path = findPath(this.grid, { x: guide.x, y: guide.y }, goal, WORLD_W, WORLD_H);
          void guide.walk(path.length ? path : [goal], d > 160 ? 78 : 58);   // a brisk walk from afar, an easy one up close
        }
      };
      this.events.on('update', step);
    });
    guide.stopWalking(); guide.anims.timeScale = 1;
    if (cancelled()) return false;
    const dx = p.x - guide.x, dy = p.y - guide.y;
    guide.look(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), false);
    p.look(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'up' : 'down'), false);
    guide.gesture('wave');
    this.bubble.hide();
    await new Promise(r => this.time.delayedCall(450, r));
    return !cancelled();
  }
  skipTour() { this.tourCancel = true; }
  /** replay from the menu: only meaningful inside the realm */
  replayTour(realm: Realm) {
    if (this.stable !== realm) { bus.emit('toast', `Step into the ${realm === 'casino' ? 'Casino' : 'Church'} first.`); return; }
    this.startTour(realm);
  }
  setPlayerLocked(v: boolean) { if (this.player) this.player.locked = v || !!this.gateAsk; }

  /** the player answered the "enter this realm?" prompt */
  resolveGate(enter: boolean) {
    const realm = this.gateAsk, leaving = this.gateLeave; this.gateAsk = null; this.gateLeave = false;
    if (!realm || !this.player) return;
    if (leaving) {
      if (enter) { this.gatePass = 'plaza'; audio.music('main'); }                    // start the crossfade as they walk out
      else { this.player.x = realm === 'casino' ? CASINO_WALL_X - 14 : CHURCH_WALL_X + GAP + 14; this.gatePass = null; }
    } else if (enter) { this.gatePass = realm; audio.music(realm); }                  // start the crossfade as they walk in
    else { this.player.x = realm === 'casino' ? CASINO_WALL_X + GAP + 14 : CHURCH_WALL_X - 14; this.gatePass = null; }
    this.player.locked = false;
  }

  // ------------------------------------------------------------------ per-frame
  update(_t: number, dt: number) {
    this.watchdog();
    if (this.player && this.playing) {
      this.player.step(dt);
      this.checkZones();
    }
    this.followCam(dt);
    for (const d of this.doorSprites) this.updateDoor(d);
    for (const s of this.signEls) {
      overlay.place(s.el, s.x, s.y, s.anchor);
      if (s.kind === 'casino' || s.kind === 'church') s.el.style.fontSize = `${Math.round(overlay.k * 10)}px`;
      else if (s.kind === 'gateC' || s.kind === 'gateH') s.el.style.fontSize = `${overlay.k.toFixed(3)}px`;
      else if (s.kind === 'dirL' || s.kind === 'dirR') s.el.style.fontSize = `${Math.round(overlay.k * 3.6)}px`;
      else if (s.kind === 'zone') s.el.style.fontSize = `${Math.round(overlay.k * 6)}px`;
      else if (s.kind === 'limit') { s.el.style.fontSize = `${(overlay.k * 3.6).toFixed(2)}px`; const t = `<small>MAX BET</small><b>${Math.max(...TABLE.bets)}</b>`; if (s.el.innerHTML !== t) s.el.innerHTML = t; }
      else if (s.kind === 'ticker') { s.el.style.fontSize = `${(overlay.k * 3.2).toFixed(2)}px`; s.el.style.width = `${Math.round(overlay.k * 62)}px`; }
      else if (s.kind === 'btc') { s.el.style.fontSize = `${(overlay.k * 3.6).toFixed(2)}px`; s.el.style.width = `${Math.round(overlay.k * 48)}px`; }
      if ((s.kind === 'tag' || s.kind === 'sale') && this.player) s.el.classList.toggle('near', Math.hypot(this.player.x - s.x, this.player.y - s.y) < 110);
    }
    this.tagged.forEach(c => c.placeTag());
    if (this.player) this.player.setMeter(store.realm === 'casino' ? 'luck' : store.realm === 'church' ? 'faith' : null, store.realm === 'casino' ? store.eco.luck : store.eco.faith);
    this.marker.update();
    this.bubble.update();
    this.hint.update();
    if (!this.player || !this.playing) return;
    const p = this.player;

    // interaction prompt
    let found: Interactable | undefined;
    for (const it of this.world.interactables) {
      const r = it.rect;
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) { found = it; break; }
    }
    if (found !== this.current) { this.current = found; this.refreshPrompt(); }
    this.checkSide(found, _t);
    if (this.promptEl.style.display !== 'none') overlay.place(this.promptEl, p.x, p.y - 40 * CHAR_SCALE);
    if (input.pressed('interact') && this.current && !this.touring && !this.bubble.visible) this.interact(this.current);
    else if (input.pressed('interact') && !this.current && this.sideOf && !this.touring && !this.talkingTo) this.showSide(this.sideOf, true);
    else if (input.pressed('interact') && this.talkingTo) this.advanceTalk();
    if (input.pressed('cancel') && this.talkingTo) this.endTalk();
    if (input.pressed('menu')) bus.emit('menu');
  }

  /** If the canvas size ever drifts from the window (mobile URL bar, keyboard, fullscreen), put it right. */
  private lastCheck = 0;
  private watchdog() {
    const now = performance.now();
    if (now - this.lastCheck < 500) return;
    this.lastCheck = now;
    const m = this.metrics();
    const cam = this.cameras.main;
    if (cam.zoom !== m.z || cam.width !== m.W || cam.height !== m.vh || cam.y !== m.top) this.applyView(true);   // zoom/viewport drifted: put it right
  }

  /** Realm presence. Walking from the plaza into a doorway asks first. */
  private checkZones() {
    const p = this.player!;
    const x = p.x;
    const inCasinoGap = x >= CASINO_WALL_X && x < CASINO_WALL_X + GAP;
    const inChurchGap = x >= CHURCH_WALL_X && x < CHURCH_WALL_X + GAP;
    const inDoorRows = p.y > DOOR_Y0 && p.y < DOOR_Y1;
    const side: Zone = x < CASINO_WALL_X ? 'casino' : x >= CHURCH_WALL_X + GAP ? 'church' : (inCasinoGap || inChurchGap) ? this.stable : 'plaza';

    // stepping into a doorway from the plaza: ask
    // leaving: stepping from inside a realm into its doorway asks first as well
    if ((this.stable === 'casino' && inCasinoGap || this.stable === 'church' && inChurchGap) && inDoorRows && !this.gateAsk && this.gatePass !== 'plaza') {
      this.gateAsk = this.stable; this.gateLeave = true; p.locked = true;
      bus.emit('realmGate', this.stable, true);
      return;
    }
    if (this.stable === 'plaza' && (inCasinoGap || inChurchGap) && inDoorRows && !this.gateAsk) {
      const realm: Realm = inCasinoGap ? 'casino' : 'church';
      if (this.gatePass !== realm) {
        this.gateAsk = realm; this.gateLeave = false; p.locked = true;
        bus.emit('realmGate', realm, false);
        return;
      }
    }
    if (!inCasinoGap && !inChurchGap && !this.gateAsk) audio.zone(side);   // outside a doorway the music always follows the zone the player is really in (also undoes an early crossfade)
    if (side !== this.stable && !inCasinoGap && !inChurchGap) {
      const prev = this.stable;
      this.stable = side;
      this.gatePass = null;
      store.setRealm(side);
      void backend.enterRealm(side).catch(() => { /* fire-and-forget: movement never waits on the network (rate_limited is fine) */ });
      this.cameras.main.flash(side === 'plaza' ? 160 : 280, 255, 236, 190);
      bus.emit('realm', side, false);
      if (prev !== 'plaza' && this.touring) this.tourCancel = true;
      if (side !== 'plaza' && this.pending[side]) this.time.delayedCall(900, () => this.startTour(side));
    }
  }

  /** Tap/click on the world: walk there by pathfinding; tapping a prop or host walks up and opens it. */
  private onTap(cx: number, cy: number) {
    const p = this.player; if (!p || !this.playing || p.locked || this.gateAsk) return;
    const pt = overlay.toWorld(cx, cy);
    if (this.talkingTo) this.endTalk();
    // what did they tap? the standing area of an interactable, extended upward over the prop itself
    let target: Interactable | undefined, best = 1e9;
    for (const it of this.world.interactables) {
      const r = it.rect, up = it.kind === 'npc' ? 34 : 52;
      if (pt.x < r.x - 10 || pt.x > r.x + r.w + 10 || pt.y < r.y - up || pt.y > r.y + r.h + 6) continue;
      const d = Math.hypot(pt.x - (r.x + r.w / 2), pt.y - (r.y + r.h / 2));
      if (d < best) { best = d; target = it; }
    }
    for (const n of this.npcs.values()) {
      if (n.role === 'patron') continue;
      if (Math.abs(pt.x - n.x) < 12 && pt.y > n.y - 40 && pt.y < n.y + 6) { target = this.world.interactables.find(i => i.npc === (n.role === 'owner' ? 'owner' : 'priest')) ?? target; }
    }
    let goal = { x: Math.max(8, Math.min(WORLD_W - 8, pt.x)), y: Math.max(8, Math.min(WORLD_H - 8, pt.y)) };
    if (target) {
      const r = target.rect;
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) { if (!this.touring) this.interact(target); return; }
      goal = { x: Math.max(r.x + 4, Math.min(r.x + r.w - 4, p.x)), y: Math.max(r.y + 4, Math.min(r.y + r.h - 4, p.y)) };
    }
    const path = findPath(this.grid, { x: p.x, y: p.y }, goal, WORLD_W, WORLD_H);
    this.tapFx(goal.x, goal.y, !!target);
    p.goTo(path, () => { if (target && !this.touring && this.playing && !p.locked) this.interact(target); });
  }
  private tapFx(x: number, y: number, hit: boolean) {
    const ring = this.add.circle(x, y, 4, 0, 0).setStrokeStyle(1, hit ? 0xffe08a : 0xffffff, 0.95).setDepth(5000);
    this.tweens.add({ targets: ring, radius: 11, alpha: 0, duration: 520, onComplete: () => ring.destroy() });
  }

  /** Beside or behind a game (not at its front): after a short pause, the operator (or the machine) says where to stand. */
  private checkSide(found: Interactable | undefined, now: number) {
    const p = this.player!;
    let side: Interactable | undefined;
    if (!found && !this.touring && !p.locked) {
      for (const it of this.world.interactables) {
        const r = it.around;
        if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) { side = it; break; }
      }
    }
    if (side !== this.sideOf) {
      if (this.sideOf && this.hint.visible) this.hint.hide();
      this.sideOf = side; this.sideSince = now;
    }
    if (!side) return;
    const told = this.sideTold.get(side.id) ?? -1e9;
    if (!this.hint.visible && now - this.sideSince > 700 && now - told > 9000) this.showSide(side, false);
  }
  private showSide(it: Interactable, force: boolean) {
    if (!force && this.bubble.visible) return;
    const op = it.op ? this.npcs.get(it.op) : undefined;
    const r = it.rect;
    const LINES: Record<string, string> = {
      'p-dealer': 'Players sit on the other side, friend. Come round to the stools at the front to play.',
      'p-croupier': 'Bets are placed from the front of the table. Walk round to the stools to play.',
      'p-dice': 'Wrong side of the table! Come round the front, by the stools, to roll.',
    };
    const text = (op && LINES[it.op!]) || (it.kind === 'wheel' || it.kind === 'harmony'
      ? `Stand in front of the ${it.label} to spin it.`
      : `Come round to the front of the ${it.label} to play.`);
    // no operator: the message hangs over the machine itself (Bubble lifts it 36px above this point)
    const anchor = op ?? ({ x: r.x + r.w / 2, y: (it.around ? it.around.y : r.y) + 50 } as unknown as Phaser.GameObjects.Sprite);
    this.hint.show(anchor, op ? (it.op === 'p-dealer' ? 'Dealer' : it.op === 'p-dice' ? 'Stickman' : 'Croupier') : it.label, text);
    if (op) { const dx = this.player!.x - op.x, dy = this.player!.y - op.y; op.look(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), false); op.gesture('talk'); }
    this.sideTold.set(it.id, this.time.now);
    const seq = ++this.hintSeq;
    this.time.delayedCall(4200, () => { if (seq === this.hintSeq) this.hint.hide(); op?.look(op.facing, false); });
  }

  private refreshPrompt() {
    if (!this.current || this.touring) { this.promptEl.style.display = 'none'; return; }
    const label = this.current.kind === 'npc' ? `Talk to ${this.current.npc === 'owner' ? 'Don Fortuna' : 'Father Nakamoto'}` : this.current.label;
    this.promptEl.innerHTML = `<b>X</b><span>${label}</span><small>PRESS X</small>`;
    this.promptEl.style.display = 'flex';
  }

  private interact(it: Interactable) {
    if (it.kind === 'npc') return this.talk(this.npcs.get(it.npc!)!);
    bus.emit('panel', it.kind as PanelKind, it.label, it.id);
  }

  private talk(npc: Npc) {
    if (npc.role === 'owner' || npc.role === 'priest') {
      if (this.player) { const dx = this.player.x - npc.x, dy = this.player.y - npc.y; npc.look(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), false); }
      npc.gesture('talk');
      bus.emit('panel', 'chat', npc.role === 'owner' ? 'Don Fortuna' : 'Father Nakamoto', npc.role === 'owner' ? 'fortuna' : 'nakamoto');
      return;
    }
    this.talkingTo = npc; npc.busy = true;
    if (this.player) {
      const dx = this.player.x - npc.x, dy = this.player.y - npc.y;
      const f: Facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      npc.look(f, false);
    }
    this.advanceTalk();
  }
  private advanceTalk() {
    const npc = this.talkingTo; if (!npc) return;
    if (this.bubble.isTyping) { this.bubble.skipTyping(); return; }
    const name = npc.role === 'owner' ? HOST.casino : npc.role === 'priest' ? HOST.church : '';
    const live = npc.role === 'owner' ? this.hostLine.fortuna : npc.role === 'priest' ? this.hostLine.nakamoto : '';
    const fresh = live && !this.toldLine.has(live);
    if (fresh) this.toldLine.add(live);
    this.bubble.show(npc, name, fresh ? live : Phaser.Utils.Array.GetRandom(NPC_LINES[npc.role] ?? NPC_LINES.patron));
    npc.gesture('talk');
    this.dialogueTimer?.remove();
    this.dialogueTimer = this.time.delayedCall(6500, () => this.endTalk());
  }
  private endTalk() {
    this.dialogueTimer?.remove();
    if (this.talkingTo) { this.talkingTo.busy = false; this.talkingTo.look(this.talkingTo.facing, false); }
    this.talkingTo = undefined; this.bubble.hide();
  }

  private updateDoor(d: { s: Phaser.GameObjects.Sprite; key: string; open: boolean; trig: Rect }) {
    const inside = (x: number, y: number) => x > d.trig.x && x < d.trig.x + d.trig.w && y > d.trig.y - 10 && y < d.trig.y + d.trig.h;
    const want = (this.player ? inside(this.player.x, this.player.y) : false) || [...this.npcs.values()].some(n => inside(n.x, n.y));
    if (want && !d.open) { d.open = true; d.s.play(`anim:${d.key}_open`); }
    else if (!want && d.open) { d.open = false; d.s.play(`anim:${d.key}_close`); }
  }

  /**
   * Fast travel (the Places menu, ?play=..., window.cnc.go): stand at a place and open it. Accepts an interactable id
   * (roulette, market, cashier, offering, commission, npc-owner, ...), a kind, or a friendly alias (btc, don, priest).
   */
  travelTo(key: string): boolean {
    const alias: Record<string, string> = {
      don: 'npc-owner', fortuna: 'npc-owner', owner: 'npc-owner', priest: 'npc-priest', nakamoto: 'npc-priest', father: 'npc-priest',
      slots: 'slots-west', btc: 'market', exchange: 'market', quests: 'missions', questboard: 'missions', 'quest-board': 'missions',
      desk: 'commission', plot: 'plot-1', house: 'monitor', words: 'board',
    };
    const k = alias[key.toLowerCase()] ?? key.toLowerCase();
    const it = this.world.interactables.find(i => i.id === k) ?? this.world.interactables.find(i => i.kind === k);
    const p = this.player;
    if (!it || !p || !this.playing) return false;
    if (this.touring) this.skipTour();
    // jumping in is a deliberate choice: no guided tour pops up over the panel
    const zone: Zone = it.rect.x < CASINO_WALL_X ? 'casino' : it.rect.x >= CHURCH_WALL_X ? 'church' : 'plaza';
    if (zone !== 'plaza') this.pending[zone] = false;
    p.goTo([]);                                                  // drop any walk in progress
    p.x = it.rect.x + it.rect.w / 2; p.y = it.rect.y + it.rect.h / 2;
    this.time.delayedCall(350, () => { if (this.playing) this.interact(it); });
    return true;
  }
  /** every place, for the Places menu and the agent API */
  placeList() {
    return this.world.interactables.filter(i => !i.id.endsWith('-r')).map(i => ({
      id: i.id, kind: i.kind, label: i.kind === 'npc' ? (i.npc === 'owner' ? 'Talk to Don Fortuna' : 'Talk to Father Nakamoto')
        : i.id === 'slots-west' ? 'Slots (west)' : i.id === 'slots-east' ? 'Slots (east)' : i.label,
      realm: (i.rect.x < CASINO_WALL_X ? 'casino' : i.rect.x >= CHURCH_WALL_X ? 'church' : 'plaza') as 'casino' | 'plaza' | 'church',
    }));
  }

  /** debug: park the camera somewhere for screenshots */
  debugAt(x: number, y: number) { this.playing = false; this.world.plazaCenter = { x, y }; this.camX = x; this.camY = y; this.applyView(true); }
}
