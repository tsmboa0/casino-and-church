
/** How the Phaser camera maps the world onto the screen (device px) – shared with the DOM label layer. */
export interface Fit { z: number; vpX: number; vpY: number; vpW: number; vpH: number; dpr: number; cx: number; cy: number }

class Overlay {
  fit: Fit = { z: 1, vpX: 0, vpY: 0, vpW: 800, vpH: 400, dpr: 1, cx: 0, cy: 0 };   // cx,cy = world point at the centre of the viewport
  get root(): HTMLElement { return document.getElementById('labels')!; }
  /** world px -> CSS px (crisp DOM text lives in CSS px, not in the scaled canvas) */
  toCss(wx: number, wy: number) {
    const f = this.fit;
    return { x: (f.vpX + f.vpW / 2 + (wx - f.cx) * f.z) / f.dpr, y: (f.vpY + f.vpH / 2 + (wy - f.cy) * f.z) / f.dpr };
  }
  /** CSS px -> world px (inverse of toCss) */
  toWorld(cx: number, cy: number) {
    const f = this.fit;
    return { x: f.cx + (cx * f.dpr - (f.vpX + f.vpW / 2)) / f.z, y: f.cy + (cy * f.dpr - (f.vpY + f.vpH / 2)) / f.z };
  }
  /** CSS px per art pixel */
  get k() { return this.fit.z / this.fit.dpr; }
  /** visible world area in CSS px */
  get area() {
    const f = this.fit;
    return { l: 0, t: f.vpY / f.dpr, r: f.vpW / f.dpr, b: (f.vpY + f.vpH) / f.dpr };
  }
  make(cls: string, text = ''): HTMLElement {
    const el = document.createElement('div'); el.className = cls; el.textContent = text; this.root.appendChild(el); return el;
  }
  place(el: HTMLElement, wx: number, wy: number, anchor = '-50%, -100%') {
    const p = this.toCss(wx, wy);
    el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(${anchor})`;
  }
}
export const overlay = new Overlay();
