import { ATLAS_BASE } from '../config';

/** Draws atlas frames into DOM canvases (used for previews outside Phaser). */
class AtlasDom {
  private frames = new Map<string, { page: number; x: number; y: number; w: number; h: number }>();
  private pages: HTMLImageElement[] = [];
  ready: Promise<void>;
  constructor() { this.ready = this.load(); }
  private async load() {
    const j = await (await fetch(`${ATLAS_BASE}atlas.json`)).json();
    await Promise.all(j.textures.map((t: any, i: number) => new Promise<void>((res) => {
      const im = new Image(); im.onload = () => res(); im.src = ATLAS_BASE + t.image; this.pages[i] = im;
      for (const f of t.frames) this.frames.set(f.filename, { page: i, ...f.frame });
    })));
  }
  draw(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, scale = 1) {
    const f = this.frames.get(name); if (!f) return;
    ctx.drawImage(this.pages[f.page], f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w * scale, f.h * scale);
  }
  size(name: string) { const f = this.frames.get(name); return f ? { w: f.w, h: f.h } : { w: 0, h: 0 }; }
}
export const atlasDom = new AtlasDom();
