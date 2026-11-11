import type { Rect } from './layout';

/** Spatial hash over static AABBs. Player hitbox is a small rect at the feet. */
export class CollisionGrid {
  private cell = 32;
  private map = new Map<number, Rect[]>();
  constructor(rects: Rect[], private w: number, private h: number) {
    const cx = Math.ceil(w / this.cell);
    this.cols = cx;
    for (const r of rects) {
      const x0 = Math.floor(r.x / this.cell), x1 = Math.floor((r.x + r.w - 0.01) / this.cell);
      const y0 = Math.floor(r.y / this.cell), y1 = Math.floor((r.y + r.h - 0.01) / this.cell);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const k = y * cx + x;
        const a = this.map.get(k); if (a) a.push(r); else this.map.set(k, [r]);
      }
    }
  }
  private cols: number;

  /** does a box (x,y,w,h) overlap any collider? */
  hits(x: number, y: number, w: number, h: number): boolean {
    if (x < 0 || y < 0 || x + w > this.w || y + h > this.h) return true;
    const x0 = Math.floor(x / this.cell), x1 = Math.floor((x + w - 0.01) / this.cell);
    const y0 = Math.floor(y / this.cell), y1 = Math.floor((y + h - 0.01) / this.cell);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const a = this.map.get(cy * this.cols + cx);
      if (!a) continue;
      for (const r of a) if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
    }
    return false;
  }

  /** feet-position test with a hitbox of fw x fh centred on x, ending at y */
  feetBlocked(x: number, y: number, fw = 8, fh = 6): boolean {
    return this.hits(x - fw / 2, y - fh, fw, fh);
  }
}
