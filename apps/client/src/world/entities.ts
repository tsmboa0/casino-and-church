import Phaser from 'phaser';
import { CHAR_SCALE, type Facing } from '../config';
import type { CollisionGrid } from './collision';
import { input } from '../core/input';
import { overlay } from '../ui/overlay';
import { icon } from '../ui/icons';
import type { Pt } from './pathfind';

/** 16x32 pack character. Origin sits at the feet. Name tags are crisp DOM labels. */
export class Character extends Phaser.GameObjects.Sprite {
  facing: Facing = 'down';
  moving = false;
  charId: string;
  tagEl?: HTMLElement;
  constructor(scene: Phaser.Scene, charId: string, x: number, y: number) {
    super(scene, x, y, charId, 0);
    this.charId = charId;
    this.setOrigin(0.5, 1);
    scene.add.existing(this);
    this.setDepth(y);
    this.look('down', false);
  }
  look(f: Facing, moving: boolean) {
    this.facing = f; this.moving = moving;
    const k = `${this.charId}:${moving ? 'walk' : 'idle'}_${f}`;
    if (this.anims.currentAnim?.key !== k) this.play(k, true);
  }
  gesture(name: 'talk' | 'wave' | 'point_left' | 'point_right' | 'point_up') {
    const k = `${this.charId}:${name}`;
    if (this.scene.anims.exists(k)) this.play(k, true);
  }
  tag(text: string, kind: 'player' | 'owner' | 'priest') {
    this.tagEl = overlay.make(`nt ${kind}`, kind === 'player' ? '' : text);
    if (kind === 'player') {
      // name on top, and under it the meter of the realm you are in (LUCK in the Casino, FAITH in the Church, none at the Crossroads)
      this.tagEl.innerHTML = '<div class="pn"></div><div class="pm"><span class="pi"></span><div class="pbar"><b></b></div><em></em></div>';
      (this.tagEl.querySelector('.pn') as HTMLElement).textContent = text;
    }
    return this;
  }
  private meterKey = '';
  /** show one meter under the name (or hide it with null). Cheap: only touches the DOM when something changed. */
  setMeter(kind: 'luck' | 'faith' | null, value = 0) {
    const el = this.tagEl; if (!el) return;
    const key = `${kind}:${Math.round(value * 2)}`; if (key === this.meterKey) return; this.meterKey = key;
    const pm = el.querySelector('.pm') as HTMLElement;
    pm.style.display = kind ? 'flex' : 'none'; if (!kind) return;
    pm.className = `pm ${kind}`;
    (pm.querySelector('.pi') as HTMLElement).innerHTML = icon(kind === 'luck' ? 'clover' : 'cross', 10);
    (pm.querySelector('b') as HTMLElement).style.width = `${Math.max(0, Math.min(100, value))}%`;
    (pm.querySelector('em') as HTMLElement).textContent = String(Math.round(value));
  }
  preUpdate(t: number, d: number) {
    super.preUpdate(t, d);
    this.setDepth(this.y);
  }
  placeTag() { if (this.tagEl) overlay.place(this.tagEl, this.x, this.y - 25 * this.scaleY); }
  destroy(fromScene?: boolean) { this.tagEl?.remove(); super.destroy(fromScene); }
}

export class Player extends Character {
  speed = 62;
  runSpeed = 100;
  locked = false;
  private auto: Pt[] = [];
  private onArrive?: () => void;
  private stuck = 0;
  /** walk a path by itself (tap-to-move); any stick/keyboard input cancels it */
  goTo(path: Pt[], done?: () => void) { this.auto = path.slice(); this.onArrive = done; this.stuck = 0; }
  cancelAuto() { this.auto = []; this.onArrive = undefined; }
  get autoWalking() { return this.auto.length > 0; }
  private stepAuto(dtMs: number) {
    const t = this.auto[0];
    const dx = t.x - this.x, dy = t.y - this.y, dist = Math.hypot(dx, dy);
    const sp = this.speed * (dtMs / 1000);                           // tap-to-move walks at the normal pace
    if (dist <= Math.max(2, sp)) {
      this.x = t.x; this.y = t.y; this.auto.shift();
      if (!this.auto.length) { const cb = this.onArrive; this.onArrive = undefined; this.look(this.facing, false); cb?.(); }
      return;
    }
    const nx = this.x + (dx / dist) * sp, ny = this.y + (dy / dist) * sp;
    if (this.grid.feetBlocked(nx, ny)) { this.stuck += dtMs; if (this.stuck > 400) this.cancelAuto(); return; }
    this.stuck = 0; this.x = nx; this.y = ny;
    this.look(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), true);
    this.anims.timeScale = 1.2;
  }
  constructor(scene: Phaser.Scene, charId: string, x: number, y: number, private grid: CollisionGrid) {
    super(scene, charId, x, y);
    this.setScale(CHAR_SCALE);
  }
  step(dtMs: number) {
    if (this.locked) { this.cancelAuto(); this.look(this.facing, false); return; }
    let { x: ix, y: iy } = input;
    const moving = ix !== 0 || iy !== 0;
    if (moving) this.cancelAuto();
    else if (this.auto.length) return this.stepAuto(dtMs);
    if (!moving) { this.look(this.facing, false); return; }
    const len = Math.hypot(ix, iy); ix /= len; iy /= len;
    const mag = Math.min(1, Math.hypot(input.x, input.y));
    const sp = (input.run ? this.runSpeed : this.speed) * (0.6 + 0.4 * mag) * (dtMs / 1000);
    let nx = this.x + ix * sp, ny = this.y + iy * sp;
    if (this.grid.feetBlocked(nx, this.y)) nx = this.x;
    if (this.grid.feetBlocked(nx, ny)) ny = this.y;
    if (nx === this.x && ny === this.y) {            // corner nudge so you never snag on a prop edge
      const nudge = 2.2;
      if (iy !== 0 && ix === 0) { for (const d of [nudge, -nudge]) if (!this.grid.feetBlocked(this.x + d, this.y + iy * sp)) { nx = this.x + d; ny = this.y + iy * sp; break; } }
      if (ix !== 0 && iy === 0) { for (const d of [nudge, -nudge]) if (!this.grid.feetBlocked(this.x + ix * sp, this.y + d)) { nx = this.x + ix * sp; ny = this.y + d; break; } }
    }
    const moved = nx !== this.x || ny !== this.y;
    this.x = nx; this.y = ny;
    const f: Facing = Math.abs(ix) > Math.abs(iy) ? (ix > 0 ? 'right' : 'left') : (iy > 0 ? 'down' : 'up');
    this.look(f, moved);
    this.anims.timeScale = input.run ? 1.35 : 1;
  }
}

export class Npc extends Character {
  role: 'owner' | 'priest' | 'patron';
  home: Pt;
  wander?: Phaser.Geom.Rectangle;
  private path: Pt[] = [];
  private pause = 1000 + Math.random() * 3000;
  private onArrive?: () => void;
  speed = 22;
  busy = false;
  paused = false;
  constructor(scene: Phaser.Scene, charId: string, x: number, y: number, role: Npc['role']) {
    super(scene, charId, x, y);
    this.role = role; this.home = { x, y };
    if (role !== 'patron') this.setScale(CHAR_SCALE);
  }
  walk(path: Pt[], speed = 36): Promise<void> {
    this.path = path.slice(); this.speed = speed;
    return new Promise(res => { this.onArrive = res; if (!this.path.length) res(); });
  }
  stopWalking() { this.path = []; this.onArrive = undefined; }
  preUpdate(t: number, d: number) {
    super.preUpdate(t, d);
    const dt = d / 1000;
    if (this.path.length) {
      if (this.paused) { this.look(this.facing, false); return; }
      const p = this.path[0];
      const dx = p.x - this.x, dy = p.y - this.y, dist = Math.hypot(dx, dy);
      const stepLen = this.speed * dt;
      if (dist <= stepLen) {
        this.x = p.x; this.y = p.y; this.path.shift();
        if (!this.path.length) { this.look(this.facing, false); const cb = this.onArrive; this.onArrive = undefined; cb?.(); }
      } else {
        this.x += (dx / dist) * stepLen; this.y += (dy / dist) * stepLen;
        this.look(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), true);
      }
      return;
    }
    if (this.role === 'patron' && this.wander && !this.busy) {
      this.pause -= d;
      if (this.pause <= 0) {
        const r = this.wander;
        this.pause = 2500 + Math.random() * 5000;
        this.walk([{ x: r.x + Math.random() * r.width, y: r.y + Math.random() * r.height }], 18);
      }
    }
  }
}

/** Speech bubble: a crisp DOM box that follows the speaker, has a name plate, a fixed size
 *  (measured up-front so text never overflows or jumps) and never leaves the screen. */
export class Bubble {
  private el: HTMLElement;
  private body: HTMLElement;
  private plate: HTMLElement;
  private follow?: Phaser.GameObjects.Sprite;
  private timer = 0;
  private full = '';
  private idx = 0;
  private typing = false;
  constructor(_scene: Phaser.Scene) {
    this.el = overlay.make('bubble');
    // its own layer above the HUD (signs and gates stay below the HUD; a speech bubble may cover it)
    document.getElementById('ui')!.appendChild(this.el);
    this.el.innerHTML = '<div class="bn"></div><div class="bb"></div><i class="more">&#9660;</i><i class="tail"></i>';
    this.body = this.el.querySelector('.bb')!;
    this.plate = this.el.querySelector('.bn')!;
    this.el.style.display = 'none';
  }
  get visible() { return this.el.style.display !== 'none'; }
  get isTyping() { return this.typing; }
  show(who: Phaser.GameObjects.Sprite, name: string, text: string, charMs = 20) {
    this.follow = who; this.full = text; this.idx = 0; this.typing = true;
    this.plate.textContent = name; this.plate.style.display = name ? 'block' : 'none';
    this.body.textContent = '';
    this.el.classList.remove('done');
    this.el.style.display = 'block';
    // measure the finished box in a hidden clone: fixed width/height from the first character
    const a = overlay.area;
    const maxW = Math.max(150, Math.min(250 * this.uiScale(), (a.r - a.l) * 0.78));
    const probe = this.el.cloneNode(true) as HTMLElement;
    Object.assign(probe.style, { visibility: 'hidden', transform: 'none', display: 'block', width: `${maxW}px` });
    (probe.querySelector('.bb') as HTMLElement).textContent = text;
    overlay.root.appendChild(probe);
    const bb = probe.querySelector('.bb') as HTMLElement;
    // shrink-wrap the width for short lines
    const range = document.createRange(); range.selectNodeContents(bb);
    const natural = Math.ceil(Math.min(maxW, range.getBoundingClientRect().width + 26));
    probe.style.width = `${Math.max(natural, 110)}px`;
    const rect = probe.getBoundingClientRect();
    probe.remove();
    this.el.style.width = `${Math.ceil(rect.width)}px`;
    this.body.style.minHeight = `${Math.ceil((probe.querySelector('.bb') as HTMLElement).offsetHeight || rect.height - 14)}px`;
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      this.idx++; this.body.textContent = this.full.slice(0, this.idx);
      if (this.idx >= this.full.length) this.finish();
    }, charMs);
    this.place();
  }
  private uiScale() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1; }
  private finish() { window.clearInterval(this.timer); this.typing = false; this.el.classList.add('done'); }
  skipTyping() { this.idx = this.full.length; this.body.textContent = this.full; this.finish(); }
  update() { if (this.visible) this.place(); }
  private place() {
    if (!this.follow) return;
    const head = overlay.toCss(this.follow.x, this.follow.y - 36 * ((this.follow as any).scaleY ?? 1));
    const a = overlay.area;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let x = head.x - w / 2, y = head.y - h - 10;
    const below = y < a.t + 8;
    if (below) y = overlay.toCss(this.follow.x, this.follow.y + 8).y + 10;
    x = Math.max(a.l + 8, Math.min(a.r - w - 8, x));
    y = Math.max(a.t + 6, Math.min(a.b - h - 6, y));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.el.classList.toggle('below', below);
    (this.el.querySelector('.tail') as HTMLElement).style.left = `${Math.max(12, Math.min(w - 12, head.x - x))}px`;
  }
  hide() { window.clearInterval(this.timer); this.el.style.display = 'none'; this.typing = false; this.follow = undefined; }
}

/** Pulsing ring that shows the player what the guide is talking about. */
export class Marker {
  private el: HTMLElement;
  private at?: { x: number; y: number };
  constructor() { this.el = overlay.make('marker'); this.el.style.display = 'none'; this.el.innerHTML = '<i></i><i></i>'; }
  show(x: number, y: number) { this.at = { x, y }; this.el.style.display = 'block'; this.update(); }
  hide() { this.el.style.display = 'none'; this.at = undefined; }
  update() { if (this.at) { overlay.place(this.el, this.at.x, this.at.y, '-50%, -50%'); const k = overlay.k; this.el.style.setProperty('--k', String(k)); } }
}
